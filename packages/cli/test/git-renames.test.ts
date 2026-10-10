import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, type GitRunner, runDiff } from "../src"
import { collectRenames, parseRenameRecords } from "../src/git/renames"
import { commitAll, git, initRepository } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("git-renames")

function renames(stdout: string): ReadonlyMap<string, string> | null {
  const parsed = parseRenameRecords(stdout)
  return parsed.ok ? parsed.renames : null
}

describe("parseRenameRecords — `git diff --name-status -z` records", () => {
  it.each([
    ["a plain rename", "R094\0src/a.ts\0src/b.ts\0", [["src/a.ts", "src/b.ts"]]],
    ["a path containing a space", "R094\0src/a.ts\0src/a b.ts\0", [["src/a.ts", "src/a b.ts"]]],
    [
      "paths containing a tab",
      "R094\0src/a\tb.ts\0src/c\td.ts\0",
      [["src/a\tb.ts", "src/c\td.ts"]],
    ],
    [
      "non-ASCII paths, unquoted",
      "R100\0src/日本語.ts\0src/請求 書.ts\0",
      [["src/日本語.ts", "src/請求 書.ts"]],
    ],
    ["a diff that changed nothing", "", []],
    ["records that are not renames", "M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0", []],
    [
      "a copy's second path, so the records after it stay aligned",
      "C085\0src/a.ts\0src/b.ts\0R097\0src/c.ts\0src/d.ts\0",
      [["src/c.ts", "src/d.ts"]],
    ],
    [
      "renames among other statuses",
      "M\0src/keep.ts\0R061\0src/old name.ts\0src/new name.ts\0A\0src/added.ts\0",
      [["src/old name.ts", "src/new name.ts"]],
    ],
  ])("reads %s", (_, stdout, pairs) => {
    expect(renames(stdout)).toEqual(new Map(pairs as [string, string][]))
  })

  it("normalizes both paths to NFC, the form source.file is compared in", () => {
    const decomposed = "src/請求.ts".normalize("NFD")
    const composed = "src/請求.ts".normalize("NFC")
    expect(renames(`R100\0${decomposed}\0${decomposed}2\0`)).toEqual(
      new Map([[composed, `${composed}2`]]),
    )
  })

  it.each([
    ["a rename cut after its first path", "R094\0src/a.ts\0", 0, "R094"],
    ["a stream cut mid-field", "R094\0src/a.ts\0src/b.t", 2, "src/b.t"],
    ["a path where a status belongs", "src/a.ts\0src/b.ts\0", 0, "src/a.ts"],
  ])("refuses %s, saying where it stopped reading", (_, stdout, index, field) => {
    expect(parseRenameRecords(stdout)).toEqual({ ok: false, index, field })
  })

  it("reads what a real git writes for renamed paths with spaces and non-ASCII characters", async () => {
    const root = workspace.root
    await initRepository(root)
    await git(["config", "core.quotePath", "true"], root)
    await writeFileAt(root, "src/a.ts", "export const spaced = 1\n")
    await writeFileAt(root, "src/plain.ts", "export const nonAscii = 2\n")
    await writeFileAt(root, "src/kept.ts", "export const kept = 3\n")
    await commitAll(root, "base")
    await git(["mv", "src/a.ts", "src/a b.ts"], root)
    await git(["mv", "src/plain.ts", "src/日本語 ファイル.ts"], root)
    await writeFileAt(root, "src/kept.ts", "export const kept = 4\n")
    await writeFileAt(root, "src/new.ts", "export const fresh = 1\n")
    await commitAll(root, "head")

    const stdout = await git(
      ["diff", "--find-renames", "--name-status", "-z", "HEAD~1..HEAD"],
      root,
    )

    expect(renames(stdout)).toEqual(
      new Map([
        ["src/a.ts", "src/a b.ts".normalize("NFC")],
        ["src/plain.ts", "src/日本語 ファイル.ts".normalize("NFC")],
      ]),
    )
  })
})

describe("collectRenames — when git gives no usable hints", () => {
  const SPEC = { base: "main", head: "HEAD" }

  function answering(result: () => { stdout: string; stderr: string }): GitRunner {
    return { run: async () => result() }
  }

  it.each<[string, GitRunner, string[]]>([
    [
      "git fails",
      answering(() => {
        throw new Error("no such ref pair")
      }),
      ["Failed to collect git renames (no such ref pair)", "removed + added"],
    ],
    [
      "the record stream is unreadable",
      answering(() => ({ stdout: "R094\0src/a.ts\0", stderr: "" })),
      ["main..HEAD produced a record this parser could not read", '(field 0: "R094")'],
    ],
  ])("drops the hints and warns when %s", async (_, runner, fragments) => {
    const log = recordingLogger()

    expect(await collectRenames(runner, workspace.root, SPEC, log.warn)).toBeNull()

    expect(log.warnings).toHaveLength(1)
    for (const fragment of fragments) expect(log.warnings[0]).toContain(fragment)
  })

  it("keeps what it read but warns when git exits 0 having given up on rename detection", async () => {
    const log = recordingLogger()
    const runner = answering(() => ({
      stdout: "D\0src/a.ts\0A\0src/b.ts\0",
      stderr: "warning: exhaustive rename detection was skipped due to too many files.\n",
    }))

    expect(await collectRenames(runner, workspace.root, SPEC, log.warn)).toEqual(new Map())

    expect(log.warnings).toHaveLength(1)
    expect(log.warnings[0]).toContain("exhaustive rename detection was skipped")
    expect(log.warnings[0]).toContain("diff.renameLimit")
  })
})

describe("aburi diff — a file renamed between the revisions", () => {
  it("reports its Symbol as moved, whatever characters the path holds", async () => {
    const root = workspace.root
    await initRepository(root)
    await writePackageJson(root, { name: "demo", private: true })
    await writeConfig(root, TYPESCRIPT)
    await writeFileAt(
      root,
      "src/請求 書.ts",
      "export function invoice(): number {\n  return 1\n}\n",
    )
    await commitAll(root, "base")
    await git(["mv", "src/請求 書.ts", "src/請求 済.ts"], root)
    await commitAll(root, "head")
    const log = recordingLogger()

    const report = await runDiff({
      cwd: root,
      refSpec: "HEAD~1..HEAD",
      outputDir: resolve(root, "out"),
      failOn: "added,removed",
      warn: log.warn,
    })

    expect(report.summaryLine).toBe("+0 -0 ~0 ↔1 ⤴0")
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(log.warnings).toEqual([])
  })

  it("passes git's rename-limit warning to the caller's warn", async () => {
    const root = workspace.root
    await initRepository(root)
    await writePackageJson(root, { name: "demo", private: true })
    await writeConfig(root, TYPESCRIPT)
    for (const name of ["a", "b", "c"]) {
      await writeFileAt(root, `src/${name}.ts`, `export const ${name} = 1\n// one\n// two\n`)
    }
    await commitAll(root, "base")
    for (const name of ["a", "b", "c"]) {
      await git(["mv", `src/${name}.ts`, `src/${name}2.ts`], root)
      await writeFileAt(root, `src/${name}2.ts`, `export const ${name} = 1\n// one\n// three\n`)
    }
    await commitAll(root, "head")
    await git(["config", "diff.renameLimit", "1"], root)
    const log = recordingLogger()

    await runDiff({
      cwd: root,
      refSpec: "HEAD~1..HEAD",
      outputDir: resolve(root, "out"),
      warn: log.warn,
    })

    expect(log.warnings).toContainEqual(
      expect.stringMatching(
        /git reported while collecting renames for HEAD~1\.\.HEAD: .*rename detection was skipped/,
      ),
    )
  })
})
