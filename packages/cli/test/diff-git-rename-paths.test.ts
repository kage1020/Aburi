import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { parseRenameRecords } from "../src/commands/diff"
import { realGit as git, probeRealGit } from "./fixtures"

let scratch = ""

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
    await git(["config", "core.quotePath", "true"], scratch)
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(resolve(scratch, "src/a.ts"), "export const spaced = 1\n", "utf8")
    await writeFile(resolve(scratch, "src/plain.ts"), "export const nonAscii = 2\n", "utf8")
    await writeFile(resolve(scratch, "src/kept.ts"), "export const kept = 3\n", "utf8")
    await git(["add", "-A"], scratch)
    await git(["commit", "-q", "-m", "base"], scratch)

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

    const quoted = await git(["diff", "--find-renames", "--name-status", "HEAD~1..HEAD"], scratch)
    expect(quoted).toContain("\\346\\227\\245")
  })
})
