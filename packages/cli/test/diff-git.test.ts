import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CliError, EXIT, type GitRunner, runDiff } from "../src"

/**
 * Refspec-mode diff drives the injected `GitRunner` so we can exercise §6.4 without a
 * real git repo. Tests focus on the branches the review specifically flagged: head
 * validation, worktree cleanup, and rename-collection warnings.
 */

let scratch = ""

interface RecordedCall {
  args: readonly string[]
  cwd: string | undefined
}

function makeGit(
  handlers: Record<string, () => { stdout: string; stderr: string } | Promise<never>>,
): { runner: GitRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const runner: GitRunner = {
    async run(args, options) {
      calls.push({ args, cwd: options?.cwd })
      const key = args.slice(0, 2).join(" ")
      const handler = handlers[key]
      if (handler === undefined) return { stdout: "", stderr: "" }
      const result = await handler()
      return result
    },
  }
  return { runner, calls }
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-git-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runDiff refspec mode — head ref validation", () => {
  it("rejects a head ref that git cannot resolve (was silently falling through before)", async () => {
    let verifyCount = 0
    const runner: GitRunner = {
      async run(args, _options) {
        const key = args.slice(0, 2).join(" ")
        if (key === "rev-parse --verify") {
          verifyCount++
          if (verifyCount === 1) return { stdout: "abc\n", stderr: "" }
          throw Object.assign(new Error("unknown revision"), { code: 128 })
        }
        return { stdout: "", stderr: "" }
      },
    }
    await expect(
      runDiff({
        cwd: scratch,
        refSpec: "main..bogus",
        git: runner,
        outputDir: resolve(scratch, "out"),
        warn: () => {},
      }),
    ).rejects.toBeInstanceOf(CliError)
    // At least one rev-parse call for base plus one for head must be recorded.
    expect(verifyCount).toBe(2)
  })
})

describe("runDiff refspec mode — git executable missing", () => {
  it("reports a git-installation error, not a ref-not-found error", async () => {
    const runner: GitRunner = {
      async run() {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })
      },
    }
    await expect(
      runDiff({
        cwd: scratch,
        refSpec: "main..HEAD",
        git: runner,
        outputDir: resolve(scratch, "out"),
        warn: () => {},
      }),
    ).rejects.toThrow(/git executable not found in PATH/)
  })
})

describe("runDiff refspec mode — collectRenames failure warns", () => {
  it("does not silently return null when git diff fails", async () => {
    // Base + head verify succeed, shallow check returns false, worktree add succeeds,
    // but the rename collection fails. runDiff will still fail (the scan needs a real
    // workspace), so we snapshot the warn call before the raise.
    const warnCalls: string[] = []
    const runner: GitRunner = {
      async run(args) {
        const key = args.slice(0, 2).join(" ")
        if (key === "rev-parse --verify") return { stdout: "abc\n", stderr: "" }
        if (key === "rev-parse --is-shallow-repository") return { stdout: "false\n", stderr: "" }
        if (key === "diff --find-renames") {
          throw new Error("no such ref pair")
        }
        return { stdout: "", stderr: "" }
      },
    }
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnCalls.push(m),
    }).catch(() => {
      // The scan will fail because scratch is not a real workspace — that's expected.
    })
    expect(warnCalls.some((m) => m.includes("Failed to collect git renames"))).toBe(true)
  })
})

describe("runDiff refspec mode — worktree cleanup runs on failure", () => {
  it("issues `worktree remove` even when scan fails", async () => {
    const { runner, calls } = makeGit({
      "rev-parse --verify": () => ({ stdout: "abc\n", stderr: "" }),
      "rev-parse --is-shallow-repository": () => ({ stdout: "false\n", stderr: "" }),
      "diff --find-renames": () => ({ stdout: "", stderr: "" }),
      "worktree add": () => ({ stdout: "", stderr: "" }),
      "worktree remove": () => ({ stdout: "", stderr: "" }),
    })
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: () => {},
    }).catch(() => {
      // Scan-in-worktree will fail — we only care about the cleanup call.
    })
    const cleanup = calls.find((c) => c.args.slice(0, 2).join(" ") === "worktree remove")
    expect(cleanup).toBeDefined()
  })
})

describe("--fail-on empty string via runCli", () => {
  it("does not silently allow a fail-open configuration", async () => {
    const stub = vi.fn()
    // Just verify parse rejection surfaces through runDiff too.
    await expect(
      runDiff({
        cwd: scratch,
        refSpec: null,
        base: resolve(scratch, "b.json"),
        head: resolve(scratch, "h.json"),
        failOn: "",
      }),
    ).rejects.toThrow(/empty --fail-on/)
    expect(stub).not.toHaveBeenCalled()
  })
})

describe("SUCCESS smoke — file-mode diff still resolves EXIT.SUCCESS", () => {
  it("returns EXIT.SUCCESS with no fail-on set", async () => {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    const emptyIR = {
      $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
      generator: { name: "aburi", version: "0.0.0", plugins: [] },
      workspace: { root: ".", managers: [], languages: ["ts"] },
      components: [],
      symbols: [],
      dependencies: [],
      stats: { totalFiles: 0, parsedFiles: 0, keptSymbols: 0, droppedSymbols: 0 },
    }
    await writeFile(basePath, JSON.stringify(emptyIR), "utf8")
    await writeFile(headPath, JSON.stringify(emptyIR), "utf8")
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      outputDir: resolve(scratch, "out"),
    })
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})
