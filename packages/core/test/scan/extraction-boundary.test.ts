import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { noopRegistry } from "@aburi/test-support"
import type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  ExtractionContext,
  FrameworkClassifyContext,
  FrameworkPlugin,
  LanguagePlugin,
  OpaqueAstNode,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  SymbolClassification,
  WalkContext,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CoreError, scan } from "../../src"
import { symbolId } from "../fixtures/ir"
import {
  capturingLogger,
  effectsManifest,
  frameworkManifest,
  stubLanguagePlugin,
  useStubWorkspace,
} from "../fixtures/plugins"

function candidate(file: string): SymbolCandidate<OpaqueAstNode> {
  const base = file.replace(/[^A-Za-z0-9]/g, "_")
  return {
    id: symbolId(`stub:${file}#${base}`),
    kind: "function",
    extKind: null,
    name: base,
    visibility: "public",
    decorators: [],
    signature: null,
    source: { file, startLine: 1, endLine: 2, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
  }
}

/** Which plugin stage throws, for the file whose path is in `on`. */
type Stage = "parseFile" | "extractSymbols" | "walkBody" | "normalizeAst"

interface ThrowSpec {
  stage: Stage
  on: string
  error?: unknown
}

function stubLanguage(spec?: ThrowSpec): LanguagePlugin {
  const raise = (stage: Stage, path: string): void => {
    if (spec === undefined || spec.stage !== stage || spec.on !== path) return
    throw spec.error ?? new Error(`stub ${stage} refused ${path}`)
  }
  return stubLanguagePlugin({
    parseFile: async (file: SourceFile): Promise<ParseResult> => {
      raise("parseFile", file.path)
      return { tree: { path: file.path } as unknown as OpaqueAstNode, errors: [], imports: [] }
    },
    extractSymbols: (tree: OpaqueAstNode, ctx: ExtractionContext) => {
      raise("extractSymbols", ctx.file.path)
      void tree
      return [candidate(ctx.file.path)]
    },
    walkBody: (
      symbol: SymbolCandidate<OpaqueAstNode>,
      ctx: WalkContext<OpaqueAstNode>,
    ): BodyExtraction => {
      raise("walkBody", ctx.file.path)
      void symbol
      return {
        rules: [],
        calls: [
          {
            target: "helper.run",
            line: 1,
            argumentCount: 0,
            inAwait: false,
            inNew: false,
            literalArgs: [],
          },
        ],
      }
    },
    normalizeAst: (symbol: SymbolCandidate<OpaqueAstNode>) => {
      raise("normalizeAst", symbol.source.file)
      return "stub-ast"
    },
  })
}

function throwingFramework(on: string, error: unknown): FrameworkPlugin {
  const plugin: FrameworkPlugin = {
    manifest: frameworkManifest(),
    init: async () => {},
    classifySymbol: (
      _symbol: SymbolCandidate<OpaqueAstNode>,
      ctx: FrameworkClassifyContext,
    ): SymbolClassification | null => {
      if (ctx.file.path === on) throw error
      return null
    },
  }
  return plugin
}

function throwingEffects(on: string, error: unknown): EffectPlugin {
  const plugin: EffectPlugin = {
    manifest: effectsManifest(),
    init: async () => {},
    classify: (_call: CallCandidate, ctx: ClassifyContext): EffectClassification | null => {
      if (ctx.file.path === on) throw error
      return null
    },
  }
  return plugin
}

const workspace = useStubWorkspace("extraction-boundary")

interface RunOverrides {
  language?: LanguagePlugin
  frameworks?: readonly FrameworkPlugin[]
  effects?: readonly EffectPlugin[]
}

async function run(overrides: RunOverrides = {}) {
  const { logger, warnings } = capturingLogger()
  const result = await scan({
    workspaceRoot: workspace.root,
    config: {},
    languages: [overrides.language ?? stubLanguage()],
    frameworks: overrides.frameworks ?? [],
    effects: overrides.effects ?? [],
    registry: noopRegistry,
    components: [],
    logger,
  })
  return { result, warned: { warn: warnings } }
}

describe("a plugin throw withdraws its file and nothing else", () => {
  it.each<Stage>([
    "parseFile",
    "extractSymbols",
    "walkBody",
    "normalizeAst",
  ])("%s", async (stage) => {
    const { result } = await run({
      language: stubLanguage({ stage, on: "bad.stub" }),
    })
    const files = result.ir.symbols.map((s) => s.source.file)
    expect(files).toEqual(["a.stub", "c.stub"])
  })

  it("a framework classifier", async () => {
    const { result } = await run({
      frameworks: [throwingFramework("bad.stub", new Error("classifier refused"))],
    })
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })

  it("an effect classifier", async () => {
    const { result } = await run({
      effects: [throwingEffects("bad.stub", new Error("effects refused"))],
    })
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })
})

describe("what the caller is told", () => {
  it("names the file in skipped, with the thrown message as the detail", async () => {
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub" }),
    })
    expect(result.skipped).toEqual([
      {
        path: "bad.stub",
        reason: "extraction-failed",
        detail: "stub extractSymbols refused bad.stub",
      },
    ])
  })

  it("keeps the message on extractionFailures, where skipped cannot carry it", async () => {
    const { result } = await run({
      language: stubLanguage({ stage: "walkBody", on: "bad.stub" }),
    })
    expect(result.extractionFailures).toEqual([
      { file: "bad.stub", message: "stub walkBody refused bad.stub" },
    ])
  })

  it("warns with the file and the message", async () => {
    const { warned } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub" }),
    })
    expect(warned.warn.some((w) => w.includes("bad.stub") && w.includes("refused"))).toBe(true)
  })

  it("excludes the file from parsedFiles, the way a timed-out file is excluded", async () => {
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub" }),
    })
    expect(result.ir.stats.parsedFiles).toBe(2)
    expect(result.ir.stats.totalFiles).toBe(3)
  })

  it("records two failures in discovery order when two files throw", async () => {
    await writeFile(join(workspace.root, "b.stub"), "b", "utf8")
    const failing: LanguagePlugin = {
      ...stubLanguage(),
      extractSymbols: (_tree, ctx) => {
        if (ctx.file.path === "a.stub" || ctx.file.path === "c.stub") {
          throw new Error(`no ${ctx.file.path}`)
        }
        return [candidate(ctx.file.path)]
      },
    }
    const { result } = await run({ language: failing })
    expect(result.extractionFailures.map((f) => f.file)).toEqual(["a.stub", "c.stub"])
    expect(result.skipped.map((s) => s.path)).toEqual(["a.stub", "c.stub"])
  })

  it("leaves both lists empty when nothing throws", async () => {
    const { result } = await run()
    expect(result.extractionFailures).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.ir.symbols).toHaveLength(3)
  })

  it("reads a thrown string rather than dropping it", async () => {
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error: "just a string" }),
    })
    expect(result.extractionFailures).toEqual([{ file: "bad.stub", message: "just a string" }])
  })

  it("reads a thrown object rather than reporting [object Object]", async () => {
    const { result } = await run({
      language: stubLanguage({
        stage: "extractSymbols",
        on: "bad.stub",
        error: { reason: "grammar refused", at: 7 },
      }),
    })
    expect(result.extractionFailures).toEqual([
      { file: "bad.stub", message: '{"reason":"grammar refused","at":7}' },
    ])
  })
})

describe("a file the read cannot reach", () => {
  /** A plugin whose `parseFile` removes `victim` from disk while the scan is running. */
  function deleting(victim: string): LanguagePlugin {
    const language: LanguagePlugin = {
      ...stubLanguage(),
      parseFile: async (file: SourceFile) => {
        if (file.path === "a.stub") await rm(join(workspace.root, victim))
        return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
      },
    }
    return language
  }

  it("skips one that vanished, rather than calling it an extraction failure", async () => {
    const { result } = await run({ language: deleting("c.stub") })
    expect(result.skipped).toEqual([
      { path: "c.stub", reason: "unreadable", detail: expect.stringContaining("ENOENT") },
    ])
    expect(result.extractionFailures).toEqual([])
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "bad.stub"])
  })

  it("does not gate the run on it", async () => {
    const { result } = await run({ language: deleting("c.stub") })
    expect(result.extractionFailures).toEqual([])
  })

  it("skips one whose directory stopped being one, under whichever code the platform gives", async () => {
    await mkdir(join(workspace.root, "sub"))
    await writeFile(join(workspace.root, "sub", "d.stub"), "d", "utf8")
    const language: LanguagePlugin = {
      ...stubLanguage(),
      parseFile: async (file: SourceFile) => {
        if (file.path === "a.stub") {
          await rm(join(workspace.root, "sub"), { recursive: true })
          await writeFile(join(workspace.root, "sub"), "no longer a directory", "utf8")
        }
        return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
      },
    }

    const { result, warned } = await run({ language })

    expect(result.skipped).toEqual([
      {
        path: "sub/d.stub",
        reason: "unreadable",
        detail: expect.stringMatching(process.platform === "win32" ? /^ENOENT/ : /^ENOTDIR/),
      },
    ])
    expect(result.extractionFailures).toEqual([])
    expect(warned.warn).toEqual([
      expect.stringContaining(
        "Skipped sub/d.stub: it was no longer a file by the time it was read",
      ),
    ])
  })

  it("still ends the run for a read failure that is the machine's rather than the file's", async () => {
    const language: LanguagePlugin = {
      ...stubLanguage(),
      parseFile: async (file: SourceFile) => {
        if (file.path === "a.stub") {
          // Replace `bad.stub` with a directory: reading it fails with EISDIR, not ENOENT.
          await rm(join(workspace.root, "bad.stub"))
          await mkdir(join(workspace.root, "bad.stub"))
        }
        return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
      },
    }
    await expect(run({ language })).rejects.toThrow(/EISDIR|EPERM|EACCES/)
  })
})

describe("a fault in the plugin set is not a per-file fault", () => {
  it.each([
    ["scan-plugin-misconfigured", "effects plugin returned a Promise"],
    ["invalid-language-id", 'Symbol id language "TS" violates the lowercase-ASCII pattern'],
  ])("re-throws a coded %s, which repeats for every file", async (code, message) => {
    const error = new CoreError(message, { code: code as never, value: "stub" })
    await expect(
      run({ language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error }) }),
    ).rejects.toThrow(message)
  })

  it("re-throws a registry error about undeclared vocabulary", async () => {
    const error = Object.assign(new Error('Effect id "x-stripe:charge" is not declared'), {
      name: "RegistryError",
      code: "vocab-undeclared",
    })
    await expect(
      run({ language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error }) }),
    ).rejects.toThrow(/is not declared/)
  })

  it("absorbs a coded error that describes the file rather than the wiring", async () => {
    const error = new CoreError('qualified name "a\u{1F642}" contains a non-identifier', {
      code: "anonymous-symbol-id-attempted",
      value: "a\u{1F642}",
    })
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error }),
    })
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
    expect(result.extractionFailures[0]?.file).toBe("bad.stub")
  })

  it("keeps the code beside the message, so a caller need not match on text", async () => {
    const error = new CoreError('qualified name "a\u{1F642}" contains a non-identifier', {
      code: "anonymous-symbol-id-attempted",
      value: "a\u{1F642}",
    })
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error }),
    })
    expect(result.extractionFailures[0]?.code).toBe("anonymous-symbol-id-attempted")
  })

  it("omits the code when the thrown value carries none", async () => {
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub" }),
    })
    expect(result.extractionFailures[0]).not.toHaveProperty("code")
  })
})

describe("a throw that says nothing about itself", () => {
  it.each([
    ["an Error with no message", new Error(), /Error/],
    ["a subclass with no message", new (class Abort extends Error {})(), /Error/],
  ])("still names itself: %s", async (_label, error, pattern) => {
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error }),
    })
    // An empty `detail` is the same silence the boundary exists to replace, one step in.
    expect(result.extractionFailures[0]?.message).toMatch(pattern)
    expect(result.extractionFailures[0]?.message.length).toBeGreaterThan(0)
  })

  it("survives a value that cannot be stringified at all", async () => {
    const hostile: Record<string, unknown> = Object.create(null)
    hostile.self = hostile
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error: hostile }),
    })
    expect(result.extractionFailures).toEqual([{ file: "bad.stub", message: "[object Object]" }])
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })
})
