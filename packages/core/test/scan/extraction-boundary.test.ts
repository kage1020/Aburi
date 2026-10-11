import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { makeCall, recordingLogger } from "@aburi/test-support"
import type { LanguagePlugin, SourceFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CoreError, type ScanInput } from "../../src"
import {
  fileCandidate,
  scanStubs,
  stubEffectsPlugin,
  stubFrameworkPlugin,
  stubLanguagePlugin,
  useStubWorkspace,
} from "../fixtures/plugins"

type Stage = "parseFile" | "extractSymbols" | "walkBody" | "normalizeAst"

/** A `.stub` language whose `stage` throws `error` for `bad.stub` and behaves for every other file. */
function throwingAt(stage?: Stage, error?: unknown): LanguagePlugin {
  const raise = (at: Stage, path: string): void => {
    if (at === stage && path === "bad.stub") throw error ?? new Error(`stub ${at} refused ${path}`)
  }
  return stubLanguagePlugin({
    parseFile: async (file) => {
      raise("parseFile", file.path)
      return { tree: {}, errors: [], imports: [] }
    },
    extractSymbols: (_tree, ctx) => {
      raise("extractSymbols", ctx.file.path)
      return [fileCandidate(ctx.file.path)]
    },
    walkBody: (_symbol, ctx) => {
      raise("walkBody", ctx.file.path)
      return { rules: [], calls: [makeCall({ target: "helper.run" })] }
    },
    normalizeAst: (symbol) => {
      raise("normalizeAst", symbol.source.file)
      return "stub-ast"
    },
  })
}

const workspace = useStubWorkspace("extraction-boundary")

async function run(overrides: Partial<ScanInput> = {}) {
  const logger = recordingLogger()
  const result = await scanStubs(workspace.root, {
    languages: [throwingAt()],
    logger,
    ...overrides,
  })
  return { result, warnings: logger.warnings }
}

/** A language whose `parseFile`, reached for `a.stub`, first does `act` to the workspace. */
function meddling(act: () => Promise<void>): LanguagePlugin {
  const language = throwingAt()
  return {
    ...language,
    parseFile: async (file: SourceFile) => {
      if (file.path === "a.stub") await act()
      return language.parseFile(file)
    },
  }
}

describe("a plugin throw withdraws its file and nothing else", () => {
  it.each<[string, Partial<ScanInput>]>([
    ["parseFile", { languages: [throwingAt("parseFile")] }],
    ["extractSymbols", { languages: [throwingAt("extractSymbols")] }],
    ["walkBody", { languages: [throwingAt("walkBody")] }],
    ["normalizeAst", { languages: [throwingAt("normalizeAst")] }],
    [
      "a framework classifier",
      {
        frameworks: [
          stubFrameworkPlugin("framework-stub", {
            classifySymbol: (_symbol, ctx) => {
              if (ctx.file.path === "bad.stub") throw new Error("classifier refused")
              return null
            },
          }),
        ],
      },
    ],
    [
      "an effect classifier",
      {
        effects: [
          stubEffectsPlugin("effects-stub", (_call, ctx) => {
            if (ctx.file.path === "bad.stub") throw new Error("effects refused")
            return null
          }),
        ],
      },
    ],
  ])("%s", async (_thrower, overrides) => {
    const { result } = await run(overrides)
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })
})

describe("what the caller is told", () => {
  it("names the file in skipped and extractionFailures, and warns, with the thrown message", async () => {
    const { result, warnings } = await run({ languages: [throwingAt("walkBody")] })

    expect(result.skipped).toEqual([
      { path: "bad.stub", reason: "extraction-failed", detail: "stub walkBody refused bad.stub" },
    ])
    expect(result.extractionFailures).toEqual([
      { file: "bad.stub", message: "stub walkBody refused bad.stub" },
    ])
    expect(warnings).toEqual([
      "Skipped bad.stub: extraction threw — stub walkBody refused bad.stub",
    ])
  })

  it("excludes the file from parsedFiles, the way a timed-out file is excluded", async () => {
    const { result } = await run({ languages: [throwingAt("extractSymbols")] })
    expect(result.ir.stats.parsedFiles).toBe(2)
    expect(result.ir.stats.totalFiles).toBe(3)
  })

  it("records two failures in discovery order when two files throw", async () => {
    await writeFile(join(workspace.root, "b.stub"), "b", "utf8")
    const failing = stubLanguagePlugin({
      extractSymbols: (_tree, ctx) => {
        if (ctx.file.path === "a.stub" || ctx.file.path === "c.stub")
          throw new Error(`no ${ctx.file.path}`)
        return [fileCandidate(ctx.file.path)]
      },
    })
    const { result } = await run({ languages: [failing] })
    expect(result.extractionFailures.map((f) => f.file)).toEqual(["a.stub", "c.stub"])
    expect(result.skipped.map((s) => s.path)).toEqual(["a.stub", "c.stub"])
  })

  it("reads a thrown value that is not an Error rather than dropping it", async () => {
    const { result } = await run({
      languages: [throwingAt("extractSymbols", { reason: "grammar refused", at: 7 })],
    })
    expect(result.extractionFailures).toEqual([
      { file: "bad.stub", message: '{"reason":"grammar refused","at":7}' },
    ])
  })

  it("leaves both lists empty when nothing throws", async () => {
    const { result } = await run()
    expect(result.extractionFailures).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.ir.symbols).toHaveLength(3)
  })
})

describe("a file the read cannot reach", () => {
  it("skips one that vanished, rather than calling it an extraction failure", async () => {
    const { result } = await run({
      languages: [meddling(() => rm(join(workspace.root, "c.stub")))],
    })
    expect(result.skipped).toEqual([
      { path: "c.stub", reason: "unreadable", detail: expect.stringContaining("ENOENT") },
    ])
    expect(result.extractionFailures).toEqual([])
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "bad.stub"])
  })

  it("skips one whose directory stopped being one, under whichever code the platform gives", async () => {
    await workspace.writeSource("sub/d.stub", "d")
    const { result, warnings } = await run({
      languages: [
        meddling(async () => {
          await rm(join(workspace.root, "sub"), { recursive: true })
          await writeFile(join(workspace.root, "sub"), "no longer a directory", "utf8")
        }),
      ],
    })

    expect(result.skipped).toEqual([
      {
        path: "sub/d.stub",
        reason: "unreadable",
        detail: expect.stringMatching(process.platform === "win32" ? /^ENOENT/ : /^ENOTDIR/),
      },
    ])
    expect(result.extractionFailures).toEqual([])
    expect(warnings).toEqual([
      expect.stringContaining(
        "Skipped sub/d.stub: it was no longer a file by the time it was read",
      ),
    ])
  })

  it("still ends the run for a read failure that is the machine's rather than the file's", async () => {
    const language = meddling(async () => {
      await rm(join(workspace.root, "bad.stub"))
      await mkdir(join(workspace.root, "bad.stub"))
    })
    await expect(run({ languages: [language] })).rejects.toThrow(/EISDIR|EPERM|EACCES/)
  })
})

describe("a fault in the plugin set is not a per-file fault", () => {
  it.each([
    ["scan-plugin-misconfigured", "effects plugin returned a Promise"],
    ["invalid-language-id", 'Symbol id language "TS" violates the lowercase-ASCII pattern'],
  ])("re-throws a coded %s, which repeats for every file", async (code, message) => {
    const error = new CoreError(message, { code: code as never, value: "stub" })
    await expect(run({ languages: [throwingAt("extractSymbols", error)] })).rejects.toThrow(message)
  })

  it("re-throws a registry error about undeclared vocabulary", async () => {
    const error = Object.assign(new Error('Effect id "x-stripe:charge" is not declared'), {
      name: "RegistryError",
      code: "vocab-undeclared",
    })
    await expect(run({ languages: [throwingAt("extractSymbols", error)] })).rejects.toThrow(
      /is not declared/,
    )
  })

  it("absorbs a coded error that describes the file, and keeps its code beside the message", async () => {
    const error = new CoreError('qualified name "a\u{1F642}" contains a non-identifier', {
      code: "anonymous-symbol-id-attempted",
      value: "a\u{1F642}",
    })
    const { result } = await run({ languages: [throwingAt("extractSymbols", error)] })

    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
    expect(result.extractionFailures).toEqual([
      { file: "bad.stub", message: error.message, code: "anonymous-symbol-id-attempted" },
    ])
  })

  it("omits the code when the thrown value carries none", async () => {
    const { result } = await run({ languages: [throwingAt("extractSymbols")] })
    expect(result.extractionFailures[0]).not.toHaveProperty("code")
  })
})
