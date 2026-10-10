import { noopRegistry, silentLogger } from "@aburi/test-support"
import type {
  BodyExtraction,
  ExtractionContext,
  ImportEdge,
  LanguagePlugin,
  OpaqueAstNode,
  ParsedTree,
  ParseError,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  buildDropCFilter,
  type ExtractedFile,
  type FilePipelineResult,
  runFilePipeline,
  type TreeReleaseFailure,
  VocabCheck,
} from "../../src"
import { makeLanguageId } from "../../src/id"
import { spend } from "../fixtures/clock"
import { langManifest, NO_CAPABILITIES, stubCandidate, stubFile } from "../fixtures/plugins"

const PLUGIN_NAME = "lang-stub"

type Stage = "extractSymbols" | "walkBody" | "normalizeAst"

interface StubOptions {
  /** The handle `parseFile` returns. `null` is the plugin saying it could not build one. */
  tree?: ParsedTree | null
  parseErrors?: readonly ParseError[]
  /** Overridable to a value no plugin should return, for the malformed-plugin paths. */
  imports?: unknown
  /** Names of the candidates `extractSymbols` returns. Defaults to one. */
  candidates?: readonly string[]
  releaseTreeOverride?: { value: unknown }
  releaseThrows?: unknown
  throwFrom?: Stage
  /** Wall clock each stage spends, for the deadline readings. */
  parseMs?: number
  extractMs?: number
  walkMsPerCandidate?: number
}

class StubLanguagePlugin implements LanguagePlugin {
  readonly manifest = langManifest(PLUGIN_NAME)
  readonly languageId = makeLanguageId("stub")
  readonly fileExtensions = [".stub"]
  readonly capabilities = NO_CAPABILITIES
  readonly released: ParsedTree[] = []
  readonly order: string[] = []
  /** The handle `parseFile` last handed out, so a test can compare identity. */
  handedOut: ParsedTree | null = null

  constructor(private readonly options: StubOptions) {
    const override = options.releaseTreeOverride
    if (override !== undefined) {
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
      imports: ("imports" in this.options ? this.options.imports : []) as ImportEdge[],
    }
  }

  extractSymbols(_tree: ParsedTree, _ctx: ExtractionContext): SymbolCandidate<OpaqueAstNode>[] {
    this.order.push("extractSymbols")
    spend(this.options.extractMs ?? 0)
    this.failIfAsked("extractSymbols")
    return (this.options.candidates ?? ["one"]).map((name) => stubCandidate(name))
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
    language: plugin,
    frameworks: [],
    effects: [],
    registry: noopRegistry,
    vocab: new VocabCheck(noopRegistry, true),
    // The budget travels on the config, which is where the pipeline reads it from.
    config: extras.parseTimeoutMs === undefined ? {} : { parseTimeoutMs: extras.parseTimeoutMs },
    dropCFilter: buildDropCFilter(),
    component: null,
    log: silentLogger,
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

    expect(result.symbols).toHaveLength(1)
    expect(failures).toEqual([
      { plugin: PLUGIN_NAME, file: "test.stub", detail: "wasm heap is gone" },
    ])
  })

  it("does not replace the error the file was already failing with", async () => {
    const plugin = stubPlugin({
      throwFrom: "walkBody",
      releaseThrows: new Error("wasm heap is gone"),
    })
    const failures: TreeReleaseFailure[] = []

    await expect(run(plugin, { failures })).rejects.toThrow("stub walkBody exploded")
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
    const plugin = stubPlugin({ releaseTreeOverride: { value: ["not", "a", "function"] } })
    const failures: TreeReleaseFailure[] = []

    const result = expectExtracted(await run(plugin, { failures }))

    expect(result.symbols).toHaveLength(1)
    expect(failures).toEqual([
      { plugin: PLUGIN_NAME, file: "test.stub", detail: "releaseTree is a list, not a function" },
    ])
  })
})
