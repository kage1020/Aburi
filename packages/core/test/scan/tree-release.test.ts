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
import { buildDropCFilter, runFilePipeline } from "../../src"
import { symbolId } from "../fixtures/ir"

/**
 * The parse tree is the plugin's to build and the core's to free: `parseFile` hands the
 * handle over and never sees it again, so nothing but `runFilePipeline` is in a position to
 * release it. These tests pin that it happens on every path out of the pipeline, and that a
 * release failure never becomes the file's story.
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

/** A logger that keeps its warnings, for the paths whose only output is a warning. */
function capturingLog(): { log: Logger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    log: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
    },
  }
}

const stubFile: SourceFile = { path: "test.stub", content: "" }

/** Spend `ms` of wall clock, so a deadline test fails only in the direction of more time. */
function spend(ms: number): void {
  const until = performance.now() + ms
  let spins = 0
  while (performance.now() < until) spins++
  if (spins < 0) throw new Error("unreachable")
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
  /** Drop `releaseTree` entirely, the way a plugin with nothing to free would. */
  omitRelease?: boolean
  releaseThrows?: unknown
  throwFrom?: Stage
  parseMs?: number
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
    if (options.omitRelease === true) {
      // Shadowing the prototype method is how an instance of a class that has one stands in
      // for a plugin that never wrote one. An optional call reads a missing property and a
      // property holding `undefined` the same way, so the two arrive at the pipeline alike.
      Object.defineProperty(this, "releaseTree", { value: undefined, enumerable: false })
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
    this.failIfAsked("extractSymbols")
    return [candidate("one")]
  }

  walkBody(
    _symbol: SymbolCandidate<OpaqueAstNode>,
    _ctx: WalkContext<OpaqueAstNode>,
  ): BodyExtraction {
    this.order.push("walkBody")
    this.failIfAsked("walkBody")
    return { rules: [], calls: [] }
  }

  normalizeAst(_symbol: SymbolCandidate<OpaqueAstNode>): string {
    this.order.push("normalizeAst")
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

function run(plugin: StubLanguagePlugin, extras: { log?: Logger; parseTimeoutMs?: number } = {}) {
  const input: Parameters<typeof runFilePipeline>[0] = {
    file: stubFile,
    language: plugin as unknown as LanguagePlugin,
    frameworks: [],
    effects: [],
    registry: noopRegistry,
    config: {},
    dropCFilter: buildDropCFilter(),
    log: extras.log ?? silentLog,
  }
  if (extras.parseTimeoutMs !== undefined) input.parseTimeoutMs = extras.parseTimeoutMs
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
    const result = await run(plugin)

    expect(result.symbols).toHaveLength(1)
    expect(plugin.released).toHaveLength(1)
    expect(plugin.released[0]).toBe(plugin.handedOut)
  })

  it("releases only after the last plugin call that reads the tree", async () => {
    const plugin = stubPlugin()
    await run(plugin)

    expect(plugin.order).toEqual(["extractSymbols", "walkBody", "normalizeAst", "releaseTree"])
  })

  it("releases a tree the plugin handed over beside a non-recoverable error", async () => {
    // The documented shape of a file the plugin parsed and then refused: a usable tree, and
    // an error saying not to use it. The handle is still the core's to free.
    const plugin = stubPlugin({
      parseErrors: [{ message: "generated blob", line: 1, column: 1, recoverable: false }],
    })
    const result = await run(plugin)

    expect(result.terminalParseFailure).toBe(true)
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("does not call releaseTree when the plugin built no tree", async () => {
    const plugin = stubPlugin({
      tree: null,
      parseErrors: [{ message: "no tree", line: 1, column: 1, recoverable: false }],
    })
    const result = await run(plugin)

    expect(result.terminalParseFailure).toBe(true)
    expect(plugin.released).toEqual([])
  })

  it("releases the tree of a file abandoned on the parse deadline", async () => {
    const plugin = stubPlugin({ parseMs: 250 })
    const result = await run(plugin, { parseTimeoutMs: 100 })

    expect(result.parseTimeout).not.toBeNull()
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

  it("releases the tree when the plugin's own import list is unusable", async () => {
    // Plugins arrive as plain JavaScript through a `PluginRef`, so a `ParseResult` that does
    // not match its type is reachable. Normalizing the edges is the first thing the pipeline
    // does with one, and a throw there must not be the one path that leaks.
    const plugin = stubPlugin({ imports: null })

    await expect(run(plugin)).rejects.toThrow(TypeError)
    expect(plugin.released).toEqual([plugin.handedOut])
  })

  it("completes normally for a plugin that declares no releaseTree", async () => {
    const plugin = stubPlugin({ omitRelease: true })
    const result = await run(plugin)

    expect(result.symbols).toHaveLength(1)
    expect(plugin.released).toEqual([])
  })
})

describe("runFilePipeline — when releasing the tree itself fails", () => {
  it("keeps the file's result and warns, naming the file and the failure", async () => {
    const plugin = stubPlugin({ releaseThrows: new Error("wasm heap is gone") })
    const { log, warnings } = capturingLog()

    const result = await run(plugin, { log })

    expect(result.symbols).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("test.stub")
    expect(warnings[0]).toContain("wasm heap is gone")
  })

  it("does not replace the error the file was already failing with", async () => {
    // The release runs in a `finally`, where a throw would silently become the file's
    // diagnostic — sending the reader after the WASM heap for a bug in walkBody.
    const plugin = stubPlugin({
      throwFrom: "walkBody",
      releaseThrows: new Error("wasm heap is gone"),
    })
    const { log, warnings } = capturingLog()

    await expect(run(plugin, { log })).rejects.toThrow("stub walkBody exploded")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("wasm heap is gone")
  })

  it("describes a plugin that threw something that is not an Error", async () => {
    const plugin = stubPlugin({ releaseThrows: "just a string" })
    const { log, warnings } = capturingLog()

    await run(plugin, { log })

    expect(warnings[0]).toContain("just a string")
  })
})
