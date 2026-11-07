import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { git, makeSymbol, useScratchWorkspace } from "@aburi/test-support"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CliError, DIFF_JSON_FILENAME, DIFF_MD_FILENAME, EXIT, runCli, runDiff } from "../src"
import { documentWith } from "./ir-documents"
import { FAKE_LANGUAGE_PLUGIN, LANG_MANIFEST, pluginModuleSource } from "./plugin-fakes"
import { MemStream, runCliIn } from "./run-cli"
import { writeStubRepository } from "./stub-language"
import { writeFileAt, writeIRs } from "./workspace"

const workspace = useScratchWorkspace("diff-concurrency")

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * A language plugin for `.timed` files, `parseFile` running `body` with `side` set to `base` or
 * `head` by the file's name and `marks`, a directory beside the repository, to leave marks in.
 */
function timedPlugin(body: string): string {
  return pluginModuleSource(
    { ...LANG_MANIFEST, name: "lang-timed" },
    `  languageId: "timed",
  fileExtensions: [".timed"],
  capabilities: ${JSON.stringify(FAKE_LANGUAGE_PLUGIN.capabilities)},
  init: async () => {},
  parseFile: async (file) => {
    const { existsSync } = await import("node:fs")
    const { mkdir, writeFile } = await import("node:fs/promises")
    const marks = new URL("../marks/", import.meta.url)
    await mkdir(marks, { recursive: true })
    const side = file.path.includes("base") ? "base" : "head"
    const mark = (name) => writeFile(new URL(name, marks), "")
    const marked = (name) => existsSync(new URL(name, marks))
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const until = async (name, ms) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline && !marked(name)) await sleep(10)
      return marked(name)
    }
${body}
    return { tree: { path: file.path }, errors: [], imports: [] }
  },
  extractSymbols: (tree, ctx) =>
    ctx.file.path.includes("odd")
      ? [{
          id: "timed:" + ctx.file.path + "#odd",
          kind: "function",
          extKind: "timed:odd:thing",
          name: "odd",
          visibility: "public",
          decorators: [],
          signature: null,
          source: { file: ctx.file.path, startLine: 1, endLine: 2, startColumn: null, endColumn: null },
          derivedBy: [],
          bodyNode: tree,
          fullNode: tree,
        }]
      : [],
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "timed",`,
  )
}

/** A repository whose committed `base` files the working tree replaces with `head`, read by `body`. */
async function timedRepository(
  files: { base: readonly string[]; head: readonly string[] },
  body: string,
): Promise<string> {
  const repository = resolve(workspace.root, "repository")
  await writeStubRepository(repository, files, {
    languages: ["./lang-timed.mjs"],
    parseTimeoutMs: 60_000,
  })
  await writeFileAt(repository, "lang-timed.mjs", timedPlugin(body))
  return repository
}

const marked = (name: string) => existsSync(resolve(workspace.root, "marks", name))

/** Point every temporary directory the run makes at a fresh `tmp` beside the repository. */
async function temporaryDirectory(): Promise<string> {
  const directory = resolve(workspace.root, "tmp")
  await writeFileAt(directory, ".keep", "")
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, directory)
  return directory
}

/**
 * `aburi diff main..HEAD` with `flag`: its exit code, stdout, the report it wrote, and all it said,
 * the per-file log included, in the order it said it.
 */
async function diffWith(flag: string) {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const code = await runCli({
    argv: ["diff", "main..HEAD", flag],
    cwd: workspace.root,
    stdout,
    stderr,
    env: {},
  })
  const report = await Promise.all(
    [DIFF_JSON_FILENAME, DIFF_MD_FILENAME].map((name) =>
      readFile(resolve(workspace.root, "out", name), "utf8").catch(() => null),
    ),
  )
  return { code, stdout: stdout.text(), said: stderr.chunks, report }
}

describe("aburi diff — its two scans at once", () => {
  it.each([
    ["--parallel-scans", ["base-met", "head-met"], 60_000],
    ["--no-parallel-scans", ["head-met"], 200],
  ])("under %s, the scans that found the other in flight leave %j", async (flag, met, wait) => {
    const repository = await timedRepository(
      { base: ["meet-base.timed"], head: ["meet-head.timed"] },
      `    await mark(side)
    if (await until(side === "base" ? "head" : "base", ${wait})) await mark(side + "-met")`,
    )

    const { code, stderr } = await runCliIn(repository, ["diff", "main..HEAD", flag])

    expect(code, stderr).toBe(EXIT.SUCCESS)
    expect(["base-met", "head-met"].filter(marked)).toEqual(met)
  })

  it.each([
    [
      "both scans finish",
      {
        base: ["bad.stub", "warn.stub", "ok.stub"],
        head: ["zz-bad.stub", "noisy.stub", "ok.stub"],
      },
      EXIT.SUCCESS,
      "warn: Skipped zz-bad.stub",
      true,
    ],
    [
      "a scan leaves a file out",
      { base: ["ok.stub"], head: ["boom.stub", "ok.stub"] },
      EXIT.GATE,
      "plugin exploded",
      true,
    ],
    [
      "the base scan stops",
      { base: ["odd-base.stub", "ok.stub"], head: ["zz-bad.stub", "ok.stub"] },
      EXIT.GATE,
      'emitted extKind "stub:odd:thing" at odd-base.stub',
      false,
    ],
    [
      "the head scan stops",
      { base: ["bad.stub", "ok.stub"], head: ["odd-head.stub", "ok.stub"] },
      EXIT.GATE,
      'emitted extKind "stub:odd:thing" at odd-head.stub',
      false,
    ],
    [
      "both scans stop",
      { base: ["odd-base.stub", "ok.stub"], head: ["odd-head.stub", "ok.stub"] },
      EXIT.GATE,
      'emitted extKind "stub:odd:thing" at odd-base.stub',
      false,
    ],
  ])(
    "says, writes and exits what it does with one scan at a time when %s",
    async (_, files, code, says, wrote) => {
      await writeStubRepository(workspace.root, files, { pluginOptions: { "effects-prsima": {} } })

      const inTurn = await diffWith("--no-parallel-scans")

      expect(inTurn.code).toBe(code)
      expect(inTurn.said.join("")).toContain(says)
      expect(inTurn.report.every((written) => written !== null)).toBe(wrote)
      expect(await diffWith("--parallel-scans")).toEqual(inTurn)
    },
  )

  it("waits for the head scan when the base scan stops, and leaves no temporary directory", async () => {
    const tmp = await temporaryDirectory()
    const repository = await timedRepository(
      { base: ["odd-base.timed"], head: ["slow-head.timed"] },
      `    if (side === "base") await mark("base-stopping")
    else if (await until("base-stopping", 60000)) {
      await sleep(500)
      await mark("head-done")
    }`,
    )

    const { code, stderr } = await runCliIn(repository, ["diff", "main..HEAD", "--parallel-scans"])

    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain('emitted extKind "timed:odd:thing" at odd-base.timed')
    expect(marked("head-done")).toBe(true)
    expect(await readdir(tmp)).toEqual([".keep"])
  })

  it.each([
    [
      "exits",
      "process.exit(7)",
      'The scan of base ref "main" ended its worker thread with exit code 7 before it finished',
    ],
    [
      "throws from a timer",
      'setTimeout(() => { throw new Error("thrown later") }, 0)\n    await sleep(60000)',
      'The scan of base ref "main" threw outside its own error handling, on its worker thread: Error: thrown later',
    ],
  ])(
    "ends the run when a plugin on the base's thread %s, and removes the base's checkout",
    async (_, call, says) => {
      const tmp = await temporaryDirectory()
      const repository = await timedRepository(
        { base: ["ok-base.timed"], head: ["ok-head.timed"] },
        `    const { isMainThread } = await import("node:worker_threads")
    if (!isMainThread) {
    ${call}
    }`,
      )

      const { code, stderr } = await runCliIn(repository, [
        "diff",
        "main..HEAD",
        "--parallel-scans",
      ])

      expect(code).toBe(EXIT.RUNTIME)
      expect(stderr).toContain(says)
      expect(stderr).toContain("Run with --no-parallel-scans (parallelScans: false)")
      const worktrees = await git(["worktree", "list", "--porcelain"], repository)
      expect(worktrees.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1)
      expect(await readdir(tmp)).toEqual([".keep"])
    },
  )
})

describe("runDiff with parallelScans", () => {
  it("rejects with the error a scan in turn rejects with", async () => {
    await writeStubRepository(workspace.root, { base: ["odd-base.stub"], head: ["ok.stub"] })
    const rejection = async (parallelScans: boolean) => {
      const error = await runDiff({
        cwd: workspace.root,
        refSpec: "main..HEAD",
        parallelScans,
        warn: () => {},
      }).catch((thrown: unknown) => thrown)
      return error instanceof Error
        ? { type: error.constructor, ...error, message: error.message, stack: undefined }
        : error
    }

    const inTurn = await rejection(false)

    expect(inTurn).toMatchObject({ type: CliError, code: "plugin-error" })
    expect(await rejection(true)).toEqual(inTurn)
  })
})

describe("aburi diff --no-parallel-scans", () => {
  it("changes nothing when --base and --head name IR files, which it scans none of", async () => {
    const { base, head } = await writeIRs(
      workspace.root,
      documentWith({ symbols: [] }),
      documentWith({ symbols: [makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })] }),
    )
    const files = ["diff", "--base", base, "--head", head]

    const inTurn = await runCliIn(workspace.root, [...files, "--no-parallel-scans"])

    expect(inTurn.code).toBe(EXIT.SUCCESS)
    expect(await runCliIn(workspace.root, files)).toEqual(inTurn)
  })
})
