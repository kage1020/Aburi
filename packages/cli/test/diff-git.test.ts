import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CliError, EXIT, type GitRunner, runDiff } from "../src"
import { parseRenameRecords } from "../src/commands/diff"

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

describe("collectRenames — NUL-separated records", () => {
  it("asks git for -z output, so paths arrive unquoted and unsplit", async () => {
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
      // Scan-in-worktree will fail — the invocation is what this asserts.
    })
    const renameCall = calls.find((c) => c.args.slice(0, 2).join(" ") === "diff --find-renames")
    expect(renameCall?.args).toContain("-z")
    expect(renameCall?.args).toContain("--name-status")
  })

  /** The renames, or `null` where the reader refused the stream — the position it reports has
   * its own test below, and repeating it in every case would bury what each one is about. */
  function renames(stdout: string): ReadonlyMap<string, string> | null {
    const parsed = parseRenameRecords(stdout)
    return parsed.ok ? parsed.renames : null
  }

  it("reads a plain rename", () => {
    expect(renames("R094\0src/a.ts\0src/b.ts\0")).toEqual(new Map([["src/a.ts", "src/b.ts"]]))
  })

  it("keeps a target path containing a space whole", () => {
    // Whitespace-splitting produced the bogus pair `src/a.ts -> src/a` here, so the stage-2
    // match missed and the move degraded to removed + added.
    expect(renames("R094\0src/a.ts\0src/a b.ts\0")).toEqual(new Map([["src/a.ts", "src/a b.ts"]]))
  })

  it("keeps a path containing a tab whole", () => {
    // The one character the tab-separated format could not represent at all.
    expect(renames("R094\0src/a\tb.ts\0src/c\td.ts\0")).toEqual(
      new Map([["src/a\tb.ts", "src/c\td.ts"]]),
    )
  })

  it("keeps a non-ASCII path whole, unquoted and unescaped", () => {
    expect(renames("R100\0src/日本語.ts\0src/請求 書.ts\0")).toEqual(
      new Map([["src/日本語.ts", "src/請求 書.ts"]]),
    )
  })

  it("normalizes paths to NFC, the form source.file is compared in", () => {
    // A decomposed path out of git (macOS with core.precomposeUnicode off) would otherwise
    // build a map whose keys no `sym.source.file` can equal.
    const decomposed = "src/請求.ts".normalize("NFD")
    const map = renames(`R100\0${decomposed}\0${decomposed}2\0`)
    expect([...(map ?? new Map()).keys()]).toEqual(["src/請求.ts".normalize("NFC")])
    expect(map?.get("src/請求.ts".normalize("NFC"))).toBe("src/請求.ts".normalize("NFC") + "2")
  })

  it("returns an empty map for a diff that renamed nothing", () => {
    expect(renames("")).toEqual(new Map())
    expect(renames("M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0")).toEqual(new Map())
  })

  it("consumes a copy's second path, so records after it stay aligned", () => {
    // `C` carries a second path like `R` does, though it is a copy and never enters the map.
    // Skipping it on the status alone would read `src/c.ts` as the next status and pair the
    // wrong two files.
    expect(renames("C085\0src/a.ts\0src/b.ts\0R097\0src/c.ts\0src/d.ts\0")).toEqual(
      new Map([["src/c.ts", "src/d.ts"]]),
    )
  })

  it("reads renames mixed in among other statuses", () => {
    expect(
      renames("M\0src/keep.ts\0R061\0src/old name.ts\0src/new name.ts\0A\0src/added.ts\0"),
    ).toEqual(new Map([["src/old name.ts", "src/new name.ts"]]))
  })

  it("refuses a stream it cannot read rather than inventing pairs", () => {
    // Three ways the reader loses the record boundaries: a record missing a whole field, a
    // stream cut inside one — which would otherwise map a rename onto a chopped path — and a
    // first field that cannot be a status. A plausible-looking wrong rename is worse for the
    // match than no rename hint at all.
    expect(renames("R094\0src/a.ts\0")).toBeNull()
    expect(renames("R094\0src/a.ts\0src/b.t")).toBeNull()
    expect(renames("src/a.ts\0src/b.ts\0")).toBeNull()
  })

  it("says where it stopped reading, so the warning can name the field", () => {
    expect(parseRenameRecords("R094\0src/a.ts\0src/b.t")).toEqual({
      ok: false,
      index: 2,
      field: "src/b.t",
    })
    expect(parseRenameRecords("src/a.ts\0src/b.ts\0")).toEqual({
      ok: false,
      index: 0,
      field: "src/a.ts",
    })
  })

  it("warns and drops the hints when the record stream is unreadable", async () => {
    const warnCalls: string[] = []
    const { runner } = makeGit({
      "rev-parse --verify": () => ({ stdout: "abc\n", stderr: "" }),
      "rev-parse --is-shallow-repository": () => ({ stdout: "false\n", stderr: "" }),
      "diff --find-renames": () => ({ stdout: "R094\0src/a.ts\0", stderr: "" }),
      "worktree add": () => ({ stdout: "", stderr: "" }),
      "worktree remove": () => ({ stdout: "", stderr: "" }),
    })
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnCalls.push(m),
    }).catch(() => {
      // The scan will fail because scratch is not a real workspace — that's expected.
    })
    const warning = warnCalls.find((m) => m.includes("could not read"))
    // Naming the refspec and the field is what makes the line reproducible from a CI log.
    expect(warning).toContain("main..HEAD")
    expect(warning).toContain('"R094"')
  })

  it("warns when git exits 0 having given up on rename detection", async () => {
    // Over `diff.renameLimit` git succeeds, says so on stderr, and reports every move as a
    // delete plus an add. The records parse; the only evidence is the stderr line.
    const warnCalls: string[] = []
    const { runner } = makeGit({
      "rev-parse --verify": () => ({ stdout: "abc\n", stderr: "" }),
      "rev-parse --is-shallow-repository": () => ({ stdout: "false\n", stderr: "" }),
      "diff --find-renames": () => ({
        stdout: "D\0src/a.ts\0A\0src/b.ts\0",
        stderr: "warning: exhaustive rename detection was skipped due to too many files.\n",
      }),
      "worktree add": () => ({ stdout: "", stderr: "" }),
      "worktree remove": () => ({ stdout: "", stderr: "" }),
    })
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnCalls.push(m),
    }).catch(() => {
      // The scan will fail because scratch is not a real workspace — that's expected.
    })
    const warning = warnCalls.find((m) => m.includes("git reported while collecting renames"))
    expect(warning).toContain("exhaustive rename detection was skipped")
    expect(warning).toContain("diff.renameLimit")
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
      $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
      generator: { name: "aburi", version: "0.0.0", plugins: [] },
      workspace: { root: ".", managers: [], languages: ["ts"] },
      components: [],
      symbols: [],
      dependencies: [],
      stats: {
        totalFiles: 0,
        parsedFiles: 0,
        keptSymbols: 0,
        droppedSymbols: 0,
        effectPropagation: {
          sccCount: 0,
          maxSccSize: 0,
          propagatedEffectCount: 0,
          symbolsWithPropagatedEffects: 0,
        },
      },
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
