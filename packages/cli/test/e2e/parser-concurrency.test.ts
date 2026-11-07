import { cp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { gitTestEnv, useScratchWorkspace } from "@aburi/test-support"
import { afterEach, describe, expect, it } from "vitest"
import {
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  EXIT,
  IR_JSON_FILENAME,
  VOCAB_DISCOVERED_FILENAME,
} from "../../src"
import { STUB_PLUGIN, writeStubRepository, writeStubWorkspace } from "../stub-language"
import { writeConfig, writeFileAt } from "../workspace"
import { removeWorktreeTempDirs, runBin, useBuiltBin } from "./bin"
import { fixtureRoot } from "./project"

const workspace = useScratchWorkspace("parser-concurrency")

useBuiltBin()

afterEach(async () => {
  await removeWorktreeTempDirs(workspace.root)
})

/** What says how many workers a run used, and so the one line two such runs may differ by. */
const SIZING = /^debug: scan: extracting on /

interface Outcome {
  code: number | null
  stdout: string
  stderr: string[]
  written: Record<string, string>
}

async function scanned(argv: readonly string[], read: readonly string[] = []): Promise<Outcome> {
  const out = join(workspace.root, "out")
  await rm(out, { recursive: true, force: true })
  const run = await runBin(
    workspace.root,
    ["--log-level", "debug", ...argv, "--output-dir", out],
    gitTestEnv(workspace.root),
  )
  const written: Record<string, string> = {}
  for (const name of read) written[name] = await readFile(join(out, name), "utf8")
  return {
    code: run.code,
    stdout: run.stdout,
    stderr: run.stderr.split(/(?<=\n)/).filter((line) => !SIZING.test(line)),
    written,
  }
}

/** The stub language, except that on a worker it ends the thread under a file named `crash`. */
function workerEndingPlugin(end: string): string {
  return STUB_PLUGIN.replace(
    "  parseFile: async (file) => {\n",
    `  parseFile: async (file) => {
    const { isMainThread } = await import("node:worker_threads")
    if (!isMainThread && file.path.includes("crash")) {
${end}
    }
`,
  )
}

/** The stub language, except that a file named `crash` is extracted holding a function. */
const UNCLONEABLE_PLUGIN = STUB_PLUGIN.replace(
  "      source: {\n",
  `      source: {
        ...(ctx.file.path.includes("crash") ? { reader: () => ctx.file.path } : {}),
`,
)

const FILES = [
  "a-ok.stub",
  "b-bad.stub",
  "c-boom.stub",
  "d-noisy.stub",
  "e-twin.stub",
  "f-odd.stub",
  "g-notree.stub",
  "h-ok.stub",
  "i-warn.stub",
  "j-ok.stub",
]

describe("aburi scan --concurrency", () => {
  it("writes, prints and logs what one thread does, for every count of workers", async () => {
    await writeStubWorkspace(workspace.root, FILES)
    const argv = ["scan", "--discover", "--no-timestamp", "--format", "json"]
    const read = [IR_JSON_FILENAME, VOCAB_DISCOVERED_FILENAME]
    const alone = await scanned([...argv, "--concurrency", "1"], read)

    expect(alone.code).toBe(EXIT.GATE)
    expect(alone.stderr.join("")).toMatch(
      /Skipped c-boom\.stub: extraction threw — plugin exploded/,
    )
    for (const workers of ["2", "3", String(FILES.length + 4)]) {
      expect(await scanned([...argv, "--concurrency", workers], read)).toEqual(alone)
    }
  })

  it("stops at the file a strict scan stops at, saying what one thread says", async () => {
    await writeStubWorkspace(workspace.root, FILES)
    const alone = await scanned(["scan", "--concurrency", "1"])

    expect(alone.code).toBe(EXIT.GATE)
    expect(alone.stderr.join("")).toMatch(/emitted extKind "stub:odd:thing" at f-odd\.stub/)
    expect(await scanned(["scan", "--concurrency", "3"])).toEqual(alone)
  })

  it.each<[string, string, RegExp]>([
    [
      "a worker exits under",
      workerEndingPlugin("      process.exit(7)"),
      /the parser worker extracting it ended with exit code 7; a plugin may have called process\.exit\(\)/,
    ],
    [
      "a worker throws under, outside the scan's own handling",
      workerEndingPlugin(`      queueMicrotask(() => { throw new Error("escaped the scan") })
      await new Promise(() => {})`),
      /the parser worker extracting it threw outside the scan's own error handling: Error: escaped the scan/,
    ],
    [
      "whose extraction a worker cannot send back",
      UNCLONEABLE_PLUGIN,
      /extraction threw — its extraction holds a value that cannot leave the parser worker: .*could not be cloned/,
    ],
  ])("withdraws the one file %s, and extracts the rest", async (_case, plugin, why) => {
    // The second worker is handed d-ok.stub before it reaches b-crash.stub.
    await writeStubWorkspace(workspace.root, [
      "a-ok.stub",
      "b-crash.stub",
      "c-ok.stub",
      "d-ok.stub",
    ])
    await writeFileAt(workspace.root, "lang-stub.mjs", plugin)
    const run = await scanned(["scan", "--concurrency", "2"], [IR_JSON_FILENAME])
    const ir = JSON.parse(run.written[IR_JSON_FILENAME] ?? "") as {
      symbols: { source: { file: string } }[]
      stats: { skippedFiles: { path: string; reason: string }[] }
    }

    expect(run.code).toBe(EXIT.GATE)
    expect(run.stderr.join("")).toMatch(new RegExp(`Skipped b-crash\\.stub: ${why.source}`))
    expect(ir.symbols.map((symbol) => symbol.source.file)).toEqual([
      "a-ok.stub",
      "c-ok.stub",
      "d-ok.stub",
    ])
    expect(ir.stats.skippedFiles).toEqual([{ path: "b-crash.stub", reason: "extraction-failed" }])
  })

  it("ends the run once workers have ended under three files, naming them", async () => {
    const files = ["a-crash.stub", "b-crash.stub", "c-ok.stub", "d-crash.stub", "e-ok.stub"]
    await writeStubWorkspace(workspace.root, files)
    await writeFileAt(workspace.root, "lang-stub.mjs", workerEndingPlugin("      process.exit(7)"))
    const run = await scanned(["scan", "--concurrency", "2"])

    const ended =
      /^Parser workers ended 3 times \((.*)\), so the plugins, not one file, are ending them\. Run with --concurrency 1/.exec(
        run.stderr.at(-1) ?? "",
      )

    expect(run.code).toBe(EXIT.RUNTIME)
    // Which worker ends first is the scheduler's to decide.
    expect(ended?.[1]?.split("; ").sort()).toEqual(
      ["a-crash.stub", "b-crash.stub", "d-crash.stub"].map((file) => `extracting ${file}`),
    )
  })

  it("ends the run when a worker cannot load the plugins the scan loaded", async () => {
    await writeStubWorkspace(workspace.root, ["a-ok.stub", "b-ok.stub"])
    await writeFileAt(
      workspace.root,
      "lang-stub.mjs",
      `import { isMainThread } from "node:worker_threads"
if (!isMainThread) throw new Error("this plugin keeps to the main thread")
${STUB_PLUGIN}`,
    )
    const run = await scanned(["scan", "--concurrency", "2"])

    expect(run.code).toBe(EXIT.RUNTIME)
    expect(run.stderr.join("")).toMatch(
      /A parser worker failed: .*this plugin keeps to the main thread[\s\S]*Run with --concurrency 1/,
    )
  })

  it.each(["0", "-1", "1.5", "two", "99999999999999999999"])(
    "refuses --concurrency %s before it scans",
    async (value) => {
      await writeStubWorkspace(workspace.root, ["a-ok.stub"])
      const run = await scanned(["scan", "--concurrency", value])

      expect(run.code).toBe(EXIT.INPUT_ERROR)
      expect(run.stderr.join("")).toContain(
        `--concurrency must be a positive integer (got "${value}")`,
      )
    },
  )
})

describe("aburi scan --concurrency, with the language, framework and effects plugins", () => {
  it.each<[string, Record<string, unknown> | null]>([
    [
      "nestjs-billing",
      {
        languages: ["lang-typescript"],
        frameworks: ["framework-nestjs"],
        effects: ["effects-nest"],
      },
    ],
    ["effects-coverage", null],
  ])("writes the IR one thread writes over %s", async (project, config) => {
    await cp(fixtureRoot(project), workspace.root, { recursive: true })
    if (config !== null) await writeConfig(workspace.root, config)
    const alone = await scanned(["scan", "--concurrency", "1"], [IR_JSON_FILENAME])

    expect(alone.code).toBe(EXIT.SUCCESS)
    expect(await scanned(["scan", "--concurrency", "3"], [IR_JSON_FILENAME])).toEqual(alone)
  })
})

describe("aburi diff --concurrency", () => {
  it("reports what it reports with every file extracted on the main thread", async () => {
    await writeStubRepository(workspace.root, {
      base: ["a-ok.stub", "b-bad.stub", "c-ok.stub", "d-warn.stub"],
      head: ["a-ok.stub", "c-ok.stub", "d-warn.stub", "e-boom.stub", "f-ok.stub"],
    })
    const argv = ["diff", "main..HEAD", "--format", "both"]
    const read = [DIFF_JSON_FILENAME, DIFF_MD_FILENAME]
    const alone = await scanned([...argv, "--concurrency", "1"], read)

    expect(alone.code).toBe(EXIT.GATE)
    for (const together of ["--parallel-scans", "--no-parallel-scans"]) {
      expect(await scanned([...argv, together, "--concurrency", "2"], read)).toEqual(alone)
    }
  })
})
