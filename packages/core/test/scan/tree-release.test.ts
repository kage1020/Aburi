import type {
  BodyExtraction,
  ExtractionContext,
  ImportEdge,
  LangManifest,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParsedTree,
  ParseError,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  buildDropCFilter,
  type ExtractedFile,
  type FilePipelineResult,
  runFilePipeline,
  type TreeReleaseFailure,
} from "../../src"
import { spend } from "../fixtures/clock"
import { symbolId } from "../fixtures/ir"

/**
 * The parse tree is the plugin's to build and the core's to free: `parseFile` hands the
 * handle over and never sees it again, so nothing but `runFilePipeline` is in a position to
 * release it. These tests pin that it happens on every path out of the pipeline, that it
 * happens once and not before the tree's last reader, and that a release that fails is
 * recorded rather than becoming the file's story.
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

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const stubFile: SourceFile = { path: "test.stub", content: "" }

const PLUGIN_NAME = "lang-stub"

function langManifest(): LangManifest {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name: PLUGIN_NAME,
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

function candidate(name: string): SymbolCandidate<OpaqueAstNode> {
  return {
    id: symbolId(`stub:test.stub#${name}`),
    kind: "function",
    extKind: null,
    name,
    visibility: "public",
    decorators: [],
    signature: null,
    source: { file: "test.stub", startLine: 1, endLine: 2, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
  }
}

type Stage = "extractSymbols" | "walkBody" | "normalizeAst"

interface StubOptions {
  /** The handle `parseFile` returns. `null` is the plugin saying it could not build one. */
  tree?: ParsedTree | null
  parseErrors?: readonly ParseError[]
  /** Overridable to a value no plugin should return, for the malformed-plugin paths. */
  imports?: unknown
  /** Names of the candidates `extractSymbols` returns. Defaults to one. */
  candidates?: readonly string[]
  /**
   * Replaces the prototype method on the instance. `undefined` is a plugin that never wrote
   * one; anything else stands in for a plugin that wrote something that is not a function.
   */
  releaseTreeOverride?: { value: unknown }
  releaseThrows?: unknown
  throwFrom?: Stage
  /** Wall clock each stage spends, for the deadline readings. */
  parseMs?: number
  extractMs?: number
  walkMsPerCandidate?: number
}

/**
 * A plugin whose `releaseTree` is a real method reading instance state. If the pipeline ever
 * called it detached from the plugin it would throw rather than record, so every assertion
 * about the recorded trees is also an assertion that the receiver survived the call.
 */
class StubLanguagePlugin {
  readonly manifest = langManifest()
  readonly languageId = "stub"
  readonly fileExtensions = [".stub"]
  readonly capabilities = {
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
  }
  readonly released: ParsedTree[] = []
  readonly order: string[] = []
  /** The handle `parseFile` last handed out, so a test can compare identity. */
  handedOut: ParsedTree | null = null

  constructor(private readonly options: StubOptions) {
    const override = options.releaseTreeOverride
    if (override !== undefined) {
      // Shadowing the prototype method is how an instance of a class that has one stands in
      // for a plugin that wrote something else — or nothing.
      Object.defineProperty(this, "releaseTree", { value: override.value, enumerable: false })
    }
  }

  async init(): Promise<void> {}

  async parseFile(_file: SourceFile): Promise<ParseResult> {
    spend(this.options.parseMs ?? 0)
    this.handedOut = this.options.tree === undefined ? {} : this.options.tree
    return {
      tree: this.handedOut,
      errors: [...(this.options.parseErrors ?? [])],
      // Read by key presence rather than by `??`, so a test can hand over the `null` a
      // malformed plugin would and have it arrive as `null`.
      imports: ("imports" in this.options ? this.options.imports : []) as ImportEdge[],
    }
  }

  extractSymbols(_tree: ParsedTree, _ctx: ExtractionContext): SymbolCandidate<OpaqueAstNode>[] {
    this.order.push("extractSymbols")
    spend(this.options.extractMs ?? 0)
    this.failIfAsked("extractSymbols")
    return (this.options.candidates ?? ["one"]).map(candidate)
  }

  walkBody(
    symbol: SymbolCandidate<OpaqueAstNode>,
    _ctx: WalkContext<OpaqueAstNode>,
  ): BodyExtraction {
    this.order.push(`walkBody:${symbol.name}`)
    spend(this.options.walkMsPerCandidate ?? 0)
    this.failIfAsked("walkBody")
    return { rules: [], calls: [] }
  }

  normalizeAst(symbol: SymbolCandidate<OpaqueAstNode>): string {
    this.order.push(`normalizeAst:${symbol.name}`)
    this.failIfAsked("normalizeAst")
    return "stub-ast"
  }

  releaseTree(tree: ParsedTree): void {
    this.order.push("releaseTree")
    this.released.push(tree)
    if (this.options.releaseThrows !== undefined) throw this.options.releaseThrows
  }

  private failIfAsked(stage: Stage): void {
    if (this.options.throwFrom === stage) throw new Error(`stub ${stage} exploded`)
  }
}

function stubPlugin(options: StubOptions = {}): StubLanguagePlugin {
  return new StubLanguagePlugin(options)
}

interface RunExtras {
  parseTimeoutMs?: number
  /** Supply one to inspect it; otherwise a fresh collector is made and returned. */
  failures?: TreeReleaseFailure[]
}

/**
 * The file this plugin produced, narrowed. Every case that reaches for a payload here is about
 * a file that made it to the IR, so an unexpected outcome fails as itself rather than as a
 * missing property — and the reads that follow stay reads of the result, not of its kind.
 */
function expectExtracted(result: FilePipelineResult): ExtractedFile {
  if (result.kind !== "extracted") {
    throw new Error(`expected an extracted file, got a ${result.kind} one`)
  }
  return result
}

function run(plugin: StubLanguagePlugin, extras: RunExtras = {}) {
  const failures = extras.failures ?? []
  const input: Parameters<typeof runFilePipeline>[0] = {
    file: stubFile,
    language: plugin as unknown as LanguagePlugin,
    frameworks: [],
    effects: [],
    registry: noopRegistry,
    // The budget travels on the config, which is where the pipeline reads it from.
    config: extras.parseTimeoutMs === undefined ? {} : { parseTimeoutMs: extras.parseTimeoutMs },
    dropCFilter: buildDropCFilter(),
    log: silentLog,
    treeReleaseFailures: failures,
  }
  return runFilePipeline(input)
}

describe("the stub itself", () => {
  it("has a releaseTree that needs its receiver, so recording it proves the receiver survived", () => {
    const plugin = stubPlugin()
    const detached = plugin.releaseTree
    expect(() => detached({})).toThrow()
  })
})

describe("runFilePipeline — releasing the parse tree", () => {
  it("releases the tree it was handed, exactly once, on the success path", async () => {
    const plugin = stubPlugin()
    const result = expectExtracted(await run(plugin))

    expect(result.symbols).toHaveLength(1)
    expect(plugin.released).toHaveLength(1)
    expect(plugin.released[0]).toBe(plugin.handedOut)
  })

  it("releases after the last candidate is done, not after the first", async () => {
    // With one candidate a release from inside the loop is indistinguishable from a release
    // after it — and against a real tree the loop version is a use-after-free on candidate
    // two, which is worse than the leak this all exists to close.
    const plugin = stubPlugin({ candidates: ["one", "two"] })
    await run(plugin)

    expect(plugin.order).toEqual([
      "extractSymbols",
      "walkBody:one",
      "normalizeAst:one",
      "walkBody:two",
      "normalizeAst:two",
      "releaseTree",
    ])
    expect(plugin.released).toHaveLength(1)
  })

  it("releases a tree the plugin handed over beside a non-recoverable error", async () => {
    // The documented shape of a file the plugin parsed and then refused: a usable tree, and
    // an error saying not to use it. The handle is still the core's to free.
    const plugin = stubPlugin({
      parseErrors: [{ message: "generated blob", line: 1, column: 1, recoverable: false }],
    })
    const result = await run(plugin)

    expect(result.kind).toBe("parse-failed")
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("does not call releaseTree when the plugin built no tree", async () => {
    const plugin = stubPlugin({
      tree: null,
      parseErrors: [{ message: "no tree", line: 1, column: 1, recoverable: false }],
    })
    const result = await run(plugin)

    expect(result.kind).toBe("parse-failed")
    expect(plugin.released).toEqual([])
  })

  it("completes normally for a plugin that declares no releaseTree", async () => {
    const plugin = stubPlugin({ releaseTreeOverride: { value: undefined } })
    const failures: TreeReleaseFailure[] = []
    const result = expectExtracted(await run(plugin, { failures }))

    expect(result.symbols).toHaveLength(1)
    expect(plugin.released).toEqual([])
    expect(failures).toEqual([])
  })

  it("reads a null releaseTree as a plugin with nothing to free, the way an optional call does", async () => {
    // Both spellings of "no tree to free" reach the core through a `PluginRef` as plain
    // JavaScript. Narrowing to `undefined` would turn one of the two working ones into a
    // warning per file for a plugin that is behaving.
    const plugin = stubPlugin({ releaseTreeOverride: { value: null } })
    const failures: TreeReleaseFailure[] = []
    const result = expectExtracted(await run(plugin, { failures }))

    expect(result.symbols).toHaveLength(1)
    expect(failures).toEqual([])
  })
})

describe("runFilePipeline — every way out of a file releases its tree", () => {
  it("releases the tree of a file abandoned before extraction starts", async () => {
    const plugin = stubPlugin({ parseMs: 250 })
    const result = await run(plugin, { parseTimeoutMs: 100 })

    expect(result.kind).toBe("parse-timeout")
    expect(plugin.order).toEqual(["releaseTree"])
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("releases the tree of a file abandoned after extraction, before any candidate", async () => {
    const plugin = stubPlugin({ extractMs: 250 })
    const result = await run(plugin, { parseTimeoutMs: 100 })

    expect(result.kind).toBe("parse-timeout")
    expect(plugin.order).toEqual(["extractSymbols", "releaseTree"])
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("releases the tree of a file abandoned partway through its candidates", async () => {
    const plugin = stubPlugin({ candidates: ["one", "two"], walkMsPerCandidate: 150 })
    const result = await run(plugin, { parseTimeoutMs: 100 })

    expect(result.kind).toBe("parse-timeout")
    expect(plugin.order).toEqual([
      "extractSymbols",
      "walkBody:one",
      "normalizeAst:one",
      "releaseTree",
    ])
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("releases the tree when extractSymbols throws, and lets the throw through unchanged", async () => {
    const plugin = stubPlugin({ throwFrom: "extractSymbols" })

    await expect(run(plugin)).rejects.toThrow("stub extractSymbols exploded")
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("releases the tree when walkBody throws, and lets the throw through unchanged", async () => {
    const plugin = stubPlugin({ throwFrom: "walkBody" })

    await expect(run(plugin)).rejects.toThrow("stub walkBody exploded")
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("releases the tree when normalizeAst throws, and lets the throw through unchanged", async () => {
    const plugin = stubPlugin({ throwFrom: "normalizeAst" })

    await expect(run(plugin)).rejects.toThrow("stub normalizeAst exploded")
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("releases the tree when the plugin's own import list is unusable", async () => {
    // Plugins arrive as plain JavaScript through a `PluginRef`, so a `ParseResult` that does
    // not match its type is reachable. Normalizing the edges is the first thing the pipeline
    // does with one, and a throw there must not be the one path that leaks.
    const plugin = stubPlugin({ imports: null })

    await expect(run(plugin)).rejects.toThrow(TypeError)
    expect(plugin.released).toEqual([plugin.handedOut])
  })
})

describe("runFilePipeline — when releasing the tree itself fails", () => {
  it("records the plugin, the file and what it said, and keeps the file's result", async () => {
    const plugin = stubPlugin({ releaseThrows: new Error("wasm heap is gone") })
    const failures: TreeReleaseFailure[] = []

    const result = expectExtracted(await run(plugin, { failures }))

    // The file's result is *kept*, which is the half of this the outcome alone does not say:
    // the release runs in a `finally` next to the return, so a regression that swallowed the
    // throw and handed back an empty file would still be an extracted one.
    expect(result.symbols).toHaveLength(1)
    expect(failures).toEqual([
      { plugin: PLUGIN_NAME, file: "test.stub", detail: "wasm heap is gone" },
    ])
  })

  it("does not replace the error the file was already failing with", async () => {
    // The release runs in a `finally`, where a throw would silently become the file's
    // diagnostic — sending the reader after the WASM heap for a bug in walkBody.
    const plugin = stubPlugin({
      throwFrom: "walkBody",
      releaseThrows: new Error("wasm heap is gone"),
    })
    const failures: TreeReleaseFailure[] = []

    await expect(run(plugin, { failures })).rejects.toThrow("stub walkBody exploded")
    // The record survives the throw, which is why the collector is an input rather than a
    // field of the result: a file that failed both ways has no result to carry it, and a
    // plugin broken in both places is the run that most needs both facts.
    expect(failures).toEqual([
      { plugin: PLUGIN_NAME, file: "test.stub", detail: "wasm heap is gone" },
    ])
  })

  it("describes a plugin that threw something that is not an Error", async () => {
    const plugin = stubPlugin({ releaseThrows: "just a string" })
    const failures: TreeReleaseFailure[] = []

    await run(plugin, { failures })

    expect(failures[0]?.detail).toBe("just a string")
  })

  it("says a releaseTree that is not a function broke the contract, and what it was instead", async () => {
    // A `TypeError` from calling a non-function would land in the same catch as a genuine
    // parser failure and read as one — a deterministic, one-line-to-fix contract violation
    // described in the words of a runtime fault.
    const plugin = stubPlugin({ releaseTreeOverride: { value: ["not", "a", "function"] } })
    const failures: TreeReleaseFailure[] = []

    const result = expectExtracted(await run(plugin, { failures }))

    expect(result.symbols).toHaveLength(1)
    expect(failures).toEqual([
      { plugin: PLUGIN_NAME, file: "test.stub", detail: "releaseTree is a list, not a function" },
    ])
  })
})
