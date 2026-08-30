import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  EffectsManifest,
  ExtractionContext,
  FrameworkClassifyContext,
  FrameworkManifest,
  FrameworkPlugin,
  LangManifest,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  SymbolClassification,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CoreError, scan } from "../../src"
import { symbolId } from "../fixtures/ir"

/**
 * One file's plugin throw must cost that file and no other.
 *
 * `lang-plugin.md` §7.2 has said so since before there was a `try` anywhere in the scan:
 * an extraction exception skips the file and the pipeline as a whole does not stop. Until
 * the boundary existed, a single throw discarded every other file's Symbols — the run
 * produced no IR at all, so a workspace of healthy files yielded nothing because one file
 * upset one plugin.
 *
 * The stub plugin throws on demand rather than being coaxed into it, because the throw is
 * the subject: which stage raised it does not change what the boundary owes the caller, and
 * a fixture that had to reach a real guard would pin the guard instead.
 */

const noopRegistry: VocabRegistry = {
  findEffect: () => null,
  findExtKind: () => null,
  findFramework: () => null,
  findDerivedByOwner: () => null,
  isEffectOwnedBy: () => false,
  isExtKindOwnedBy: () => false,
  listEffects: () => [],
  listExtKinds: () => [],
  listFrameworks: () => [],
  listPlugins: () => [],
  assertEffectDeclared: () => {},
  assertExtKindDeclared: () => {},
}

interface Warned {
  warn: string[]
}

function collectingLogger(warned: Warned): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string) => warned.warn.push(message),
    error: () => {},
  }
}

function langManifest(): LangManifest {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name: "lang-stub",
    version: "0.0.0",
    type: "lang",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [],
      frameworks: [],
    },
  }
}

function frameworkManifest(): FrameworkManifest {
  return {
    ...langManifest(),
    name: "framework-stub",
    type: "framework",
  } as unknown as FrameworkManifest
}

function effectsManifest(): EffectsManifest {
  return {
    ...langManifest(),
    name: "effects-stub",
    type: "effects",
  } as unknown as EffectsManifest
}

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
  const plugin = {
    manifest: langManifest(),
    languageId: "stub",
    fileExtensions: [".stub"],
    capabilities: {
      hasDecorators: false,
      hasGenerics: false,
      hasAsync: false,
      hasMacros: false,
      hasPatternMatching: false,
      hasAbstractTypes: false,
      hasModules: false,
      hasNamespaces: false,
      hasTypeParameters: false,
      hasExplicitVisibility: false,
      hasJsDoc: false,
    },
    init: async () => {},
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
      // One call per Symbol, so the effect classifiers are actually reached — a body with
      // no calls never asks them anything, and a test for a throwing classifier would pass
      // against a boundary that did not exist.
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
  }
  return plugin as unknown as LanguagePlugin
}

function throwingFramework(on: string, error: unknown): FrameworkPlugin {
  const plugin = {
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
  return plugin as unknown as FrameworkPlugin
}

function throwingEffects(on: string, error: unknown): EffectPlugin {
  const plugin = {
    manifest: effectsManifest(),
    init: async () => {},
    classify: (_call: CallCandidate, ctx: ClassifyContext): EffectClassification | null => {
      if (ctx.file.path === on) throw error
      return null
    },
  }
  return plugin as unknown as EffectPlugin
}

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-extraction-boundary-"))
  // Two files either side of the failing one in discovery order, so a boundary that
  // withdrew the rest of the run rather than the file would be visible in both directions.
  await writeFile(join(workRoot, "a.stub"), "a", "utf8")
  await writeFile(join(workRoot, "bad.stub"), "bad", "utf8")
  await writeFile(join(workRoot, "c.stub"), "c", "utf8")
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

interface RunOverrides {
  language?: LanguagePlugin
  frameworks?: readonly FrameworkPlugin[]
  effects?: readonly EffectPlugin[]
}

async function run(overrides: RunOverrides = {}) {
  const warned: Warned = { warn: [] }
  const result = await scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [overrides.language ?? stubLanguage()],
    frameworks: overrides.frameworks ?? [],
    effects: overrides.effects ?? [],
    registry: noopRegistry,
    components: [],
    logger: collectingLogger(warned),
  })
  return { result, warned }
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
    await writeFile(join(workRoot, "b.stub"), "b", "utf8")
    const language = stubLanguage()
    const failing: LanguagePlugin = Object.create(language)
    failing.extractSymbols = (_tree, ctx) => {
      if (ctx.file.path === "a.stub" || ctx.file.path === "c.stub") {
        throw new Error(`no ${ctx.file.path}`)
      }
      return [candidate(ctx.file.path)]
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
    // A plugin is ordinary JavaScript loaded by ref and can throw anything. `String()` on a
    // plain object gives the reader nothing at all, which is the same silence the boundary
    // exists to avoid — one step further in.
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
    const language: LanguagePlugin = Object.create(stubLanguage())
    language.parseFile = async (file: SourceFile) => {
      if (file.path === "a.stub") await rm(join(workRoot, victim))
      return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
    }
    return language
  }

  it("skips one that vanished, rather than calling it an extraction failure", async () => {
    // Discovery lists the workspace up front and the loop reads each file when it reaches
    // it, so anything removing files while a scan runs — a concurrent build, a watch-mode
    // clean — puts a listed path out of reach. That is the condition discovery's own
    // `unreadable` already names, and it is not the plugin's doing.
    const { result } = await run({ language: deleting("c.stub") })
    expect(result.skipped).toEqual([
      { path: "c.stub", reason: "unreadable", detail: expect.stringContaining("ENOENT") },
    ])
    expect(result.extractionFailures).toEqual([])
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "bad.stub"])
  })

  it("does not gate the run on it", async () => {
    // A file that is gone is gone the same way on every machine, and a rerun is the fix.
    // Only `extractionFailures` moves the exit code, and this is not one.
    const { result } = await run({ language: deleting("c.stub") })
    expect(result.extractionFailures).toEqual([])
  })

  it("skips one whose directory stopped being one, under whichever code the platform gives", async () => {
    // The same event as a deletion — something replaced part of the path while the scan held
    // a listing of it — and the operating systems disagree about what to call it: POSIX
    // answers ENOTDIR, Windows answers ENOENT for the identical act. A predicate holding only
    // ENOENT ends the run on POSIX and absorbs it on Windows, which is one commit producing
    // two different outcomes by platform.
    await mkdir(join(workRoot, "sub"))
    await writeFile(join(workRoot, "sub", "d.stub"), "d", "utf8")
    const language: LanguagePlugin = Object.create(stubLanguage())
    language.parseFile = async (file: SourceFile) => {
      if (file.path === "a.stub") {
        await rm(join(workRoot, "sub"), { recursive: true })
        await writeFile(join(workRoot, "sub"), "no longer a directory", "utf8")
      }
      return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
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
    // "gone" would be a smaller claim than the condition: the file was never deleted, its
    // directory was, and the log line is what a reader has to reconcile with a tree where
    // something of that name is still sitting.
    expect(warned.warn).toEqual([
      expect.stringContaining(
        "Skipped sub/d.stub: it was no longer a file by the time it was read",
      ),
    ])
  })

  it("still ends the run for a read failure that is the machine's rather than the file's", async () => {
    // `EACCES`, `EMFILE`, `EIO`: whether they happen depends on how loaded or how
    // badly-checked-out the machine is, so absorbing them would let one commit produce a
    // different Document on a different day and still exit 0.
    const language: LanguagePlugin = Object.create(stubLanguage())
    language.parseFile = async (file: SourceFile) => {
      if (file.path === "a.stub") {
        // Replace `bad.stub` with a directory: reading it fails with EISDIR, not ENOENT.
        await rm(join(workRoot, "bad.stub"))
        await mkdir(join(workRoot, "bad.stub"))
      }
      return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
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
    // A `RegistryError`, not a `CoreError`, raised per file from `assertEffectDeclared` — so
    // the predicate has to read the code rather than the class. `@aburi/core` does not
    // depend on `@aburi/plugin-registry`, and absorbing this would replace one precise
    // sentence about the manifest with a file count.
    const error = Object.assign(new Error('Effect id "x-stripe:charge" is not declared'), {
      name: "RegistryError",
      code: "vocab-undeclared",
    })
    await expect(
      run({ language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error }) }),
    ).rejects.toThrow(/is not declared/)
  })

  it("absorbs a coded error that describes the file rather than the wiring", async () => {
    // `anonymous-symbol-id-attempted` is the reachable one: a declaration whose qualified
    // name the id grammar refuses. It is a property of what that file contains.
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
    // The difference between "this source is something the plugins cannot express" and "a
    // plugin crashed" is the first thing a reader wants, and the message is prose.
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
    // Circular *and* null-prototype: `JSON.stringify` throws on the cycle and `String()`
    // throws for want of a `toString`. A describe helper that threw here would escape the
    // catch it is inside and take the run down with it.
    const hostile: Record<string, unknown> = Object.create(null)
    hostile.self = hostile
    const { result } = await run({
      language: stubLanguage({ stage: "extractSymbols", on: "bad.stub", error: hostile }),
    })
    expect(result.extractionFailures).toEqual([{ file: "bad.stub", message: "[object Object]" }])
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })
})
