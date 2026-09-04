import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseRenameRecords } from "../src/commands/diff"

/**
 * The rename reader against real `git` output, on the path shapes the mocked runner in
 * `diff-git.test.ts` cannot produce (issue #81).
 *
 * A mock asserts what we believe git writes; this asserts what it writes. The two failures
 * this guards against are only visible on a real repository: a path with a space, which the
 * old whitespace split tore in half, and a non-ASCII path, which git double-quotes and
 * octal-escapes unless `-z` turns `core.quotePath` off — set to `true` here explicitly, so a
 * future invocation that drops `-z` fails the test rather than depending on the developer's
 * global config.
 */

let scratch = ""

/** Buffered, decoded once — a multi-byte character can straddle two chunks. */
function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        // Whatever the developer's ~/.gitconfig says must not decide what this test observes.
        GIT_CONFIG_GLOBAL: resolve(scratch, "absent-gitconfig"),
        GIT_CONFIG_SYSTEM: resolve(scratch, "absent-gitconfig"),
        GIT_AUTHOR_NAME: "Aburi Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Aburi Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out).toString("utf8"))
      else
        rejectPromise(
          new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString("utf8")}`),
        )
    })
  })
}

/**
 * macOS stores a filename decomposed, so a path written as NFC can come back as NFD. The
 * comparison is about which bytes belong to which path, not about which normal form the
 * filesystem chose.
 */
function nfc(map: ReadonlyMap<string, string>): Map<string, string> {
  return new Map(
    [...map].map(([from, to]) => [from.normalize("NFC"), to.normalize("NFC")] as const),
  )
}

// Long enough that git's similarity detection reports the move as a rename rather than as a
// delete plus an add.
const BODY = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i}\n`).join("")

let hasGit = true

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-git-paths-"))
  try {
    await git(["--version"], scratch)
  } catch {
    hasGit = false
  }
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("rename records from a real git repository", () => {
  it("maps paths with spaces and non-ASCII characters to their targets", async () => {
    expect(hasGit, "these tests need a git executable on PATH").toBe(true)
    await git(["init", "-q", "-b", "main"], scratch)
    // Quoting on, to prove `-z` is what suppresses it rather than the ambient config.
    await git(["config", "core.quotePath", "true"], scratch)
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(resolve(scratch, "src/a.ts"), BODY, "utf8")
    await writeFile(resolve(scratch, "src/plain.ts"), BODY, "utf8")
    await writeFile(resolve(scratch, "src/kept.ts"), BODY, "utf8")
    await git(["add", "-A"], scratch)
    await git(["commit", "-q", "-m", "base"], scratch)

    await git(["mv", "src/a.ts", "src/a b.ts"], scratch)
    await git(["mv", "src/plain.ts", "src/日本語 ファイル.ts"], scratch)
    await writeFile(resolve(scratch, "src/kept.ts"), `${BODY}export const extra = 1\n`, "utf8")
    await writeFile(resolve(scratch, "src/new.ts"), "export const fresh = 1\n", "utf8")
    await git(["add", "-A"], scratch)
    await git(["commit", "-q", "-m", "head"], scratch)

    const stdout = await git(
      ["diff", "--find-renames", "--name-status", "-z", "HEAD~1..HEAD"],
      scratch,
    )
    const map = parseRenameRecords(stdout)
    expect(map).not.toBeNull()
    expect(nfc(map ?? new Map())).toEqual(
      nfc(
        new Map([
          ["src/a.ts", "src/a b.ts"],
          ["src/plain.ts", "src/日本語 ファイル.ts"],
        ]),
      ),
    )
  })

  it("would have mis-read the same output when split on whitespace", async () => {
    // The old reader, kept here as the regression's witness: it is what turned `src/a b.ts`
    // into `src/a` and left stage 2 with no match to make.
    expect(hasGit, "these tests need a git executable on PATH").toBe(true)
    await git(["init", "-q", "-b", "main"], scratch)
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(resolve(scratch, "src/a.ts"), BODY, "utf8")
    await git(["add", "-A"], scratch)
    await git(["commit", "-q", "-m", "base"], scratch)
    await git(["mv", "src/a.ts", "src/a b.ts"], scratch)
    await git(["add", "-A"], scratch)
    await git(["commit", "-q", "-m", "head"], scratch)

    const legacy = await git(["diff", "--find-renames", "--name-status", "HEAD~1..HEAD"], scratch)
    const [status, oldPath, newPath] = legacy.split(/\r?\n/)[0]?.split(/\s+/) ?? []
    expect(status?.startsWith("R")).toBe(true)
    expect(oldPath).toBe("src/a.ts")
    expect(newPath).toBe("src/a")

    const fixed = await git(
      ["diff", "--find-renames", "--name-status", "-z", "HEAD~1..HEAD"],
      scratch,
    )
    expect(parseRenameRecords(fixed)).toEqual(new Map([["src/a.ts", "src/a b.ts"]]))
  })
})
