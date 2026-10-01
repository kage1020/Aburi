import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { parseRenameRecords } from "../src/commands/diff"
import { realGit as git, probeRealGit } from "./fixtures"

/**
 * The rename reader against real `git` output, on the path shapes the mocked runner in
 * `diff-git.test.ts` cannot produce.
 *
 * A mock asserts what we believe git writes; this asserts what it writes. The two failures it
 * guards against are only visible on a real repository: a path with a space, which a whitespace
 * split tears in half, and a non-ASCII path, which git double-quotes and octal-escapes unless
 * `-z` bypasses its path quoting entirely. `core.quotePath` is set to `true` here so this test's
 * own invocation decides what it observes rather than the developer's global config — the
 * production call site is guarded by the `-z` argument assertion in `diff-git.test.ts`.
 */

let scratch = ""

/**
 * macOS stores a filename decomposed, so a path written as NFC can come back as NFD. The reader
 * normalizes to NFC, so what this asserts is that its output is in the form `source.file` is
 * compared in — which means normalizing the *expectation*, and nothing else.
 */
function nfc(value: string): string {
  return value.normalize("NFC")
}

let gitProbeError: unknown = null

beforeAll(async () => {
  gitProbeError = await probeRealGit()
})

beforeEach(async () => {
  expect(gitProbeError, `git probe failed: ${String(gitProbeError)}`).toBeNull()
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-git-paths-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("rename records from a real git repository", () => {
  it("maps paths with spaces and non-ASCII characters to their targets", async () => {
    await git(["init", "-q", "-b", "main"], scratch)
    // Quoting on, to prove `-z` is what suppresses it rather than the ambient config.
    await git(["config", "core.quotePath", "true"], scratch)
    await mkdir(resolve(scratch, "src"), { recursive: true })
    // Distinct contents: git pairs a rename by blob, so identical files would leave the pairing
    // up to tie-breaking rather than to the input.
    await writeFile(resolve(scratch, "src/a.ts"), "export const spaced = 1\n", "utf8")
    await writeFile(resolve(scratch, "src/plain.ts"), "export const nonAscii = 2\n", "utf8")
    await writeFile(resolve(scratch, "src/kept.ts"), "export const kept = 3\n", "utf8")
    await git(["add", "-A"], scratch)
    await git(["commit", "-q", "-m", "base"], scratch)

    // `git mv` stages the move itself, so no `git add` is needed for either rename.
    await git(["mv", "src/a.ts", "src/a b.ts"], scratch)
    await git(["mv", "src/plain.ts", "src/日本語 ファイル.ts"], scratch)
    await writeFile(resolve(scratch, "src/kept.ts"), "export const kept = 4\n", "utf8")
    await writeFile(resolve(scratch, "src/new.ts"), "export const fresh = 1\n", "utf8")
    await git(["add", "-A"], scratch)
    await git(["commit", "-q", "-m", "head"], scratch)

    const stdout = await git(
      ["diff", "--find-renames", "--name-status", "-z", "HEAD~1..HEAD"],
      scratch,
    )
    const parsed = parseRenameRecords(stdout)
    expect(parsed.ok, `parser refused real git output: ${stdout}`).toBe(true)
    expect(parsed.ok ? parsed.renames : null).toEqual(
      new Map([
        ["src/a.ts", nfc("src/a b.ts")],
        ["src/plain.ts", nfc("src/日本語 ファイル.ts")],
      ]),
    )

    // What the same output looks like without `-z`, and why the reader cannot be fed it: the
    // fields are tab-separated, and a whitespace split reports this rename as `src/a.ts ->
    // src/a`. It is also where the quoting `-z` bypasses becomes visible.
    const quoted = await git(["diff", "--find-renames", "--name-status", "HEAD~1..HEAD"], scratch)
    expect(quoted).toContain("\\346\\227\\245")
  })
})
