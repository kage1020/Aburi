import {
  type CandidateOverrides,
  makeCandidate,
  noopRegistry,
  type ScratchWorkspace,
  silentLogger,
  useScratchWorkspace,
} from "@aburi/test-support"
import type {
  BodyExtraction,
  EffectPlugin,
  ExtractionContext,
  FrameworkPlugin,
  ImportEdge,
  LangManifest,
  LanguageCapabilities,
  LanguagePlugin,
  ParsedTree,
  ParseError,
  ParseResult,
  PluginManifest,
  SourceFile,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import { beforeEach, expect } from "vitest"
import {
  buildDropCFilter,
  type ExtractedFile,
  type FilePipelineInput,
  type FilePipelineResult,
  isStrict,
  runFilePipeline,
  type ScanInput,
  type ScanResult,
  scan,
  VocabCheck,
} from "../../src"
import { makeLanguageId } from "../../src/id"
import { spend } from "./clock"

const PLUGIN_SCHEMA = "https://aburi.kage1020.com/schema/aburi.plugin.v1.json"

function manifest<T extends PluginManifest["type"]>(
  type: T,
  name: string,
): PluginManifest & { type: T } {
  return {
    $schema: PLUGIN_SCHEMA,
    name,
    version: "0.0.0",
    type,
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

export function langManifest(name = "lang-stub"): LangManifest {
  return manifest("lang", name)
}

const NO_CAPABILITIES: LanguageCapabilities = {
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

const EMPTY_BODY: BodyExtraction = { rules: [], calls: [] }

/** The one file a `.stub` plugin is handed when the test is not about the file. */
const stubFile: SourceFile = { path: "test.stub", content: "" }

export function stubLanguagePlugin(overrides: Partial<LanguagePlugin> = {}): LanguagePlugin {
  return {
    manifest: langManifest(),
    languageId: makeLanguageId("stub"),
    fileExtensions: [".stub"],
    capabilities: NO_CAPABILITIES,
    init: async () => {},
    parseFile: async (): Promise<ParseResult> => ({ tree: {}, errors: [], imports: [] }),
    extractSymbols: () => [],
    walkBody: () => EMPTY_BODY,
    normalizeAst: () => "stub-ast",
    ...overrides,
  }
}

/** A `.stub` language yielding `fileCandidate` for every file it parses. */
export function oneSymbolPerFile(overrides: Partial<LanguagePlugin> = {}): LanguagePlugin {
  return stubLanguagePlugin({
    extractSymbols: (_tree, ctx) => [fileCandidate(ctx.file.path)],
    ...overrides,
  })
}

/** A framework plugin that classifies nothing unless `overrides` says otherwise. */
export function stubFrameworkPlugin(
  name = "framework-stub",
  overrides: Partial<FrameworkPlugin> = {},
): FrameworkPlugin {
  return {
    manifest: manifest("framework", name),
    init: async () => {},
    classifySymbol: () => null,
    ...overrides,
  }
}

export function stubEffectsPlugin(name: string, classify: EffectPlugin["classify"]): EffectPlugin {
  return { manifest: manifest("effects", name), init: async () => {}, classify }
}

export function stubCandidate(
  name: string,
  overrides: Omit<CandidateOverrides, "kind"> & {
    kind?: CandidateOverrides["kind"]
    file?: string
  } = {},
): SymbolCandidate {
  const { id, file = "test.stub", ...rest } = overrides
  const candidate = makeCandidate({
    kind: "function",
    id: id ?? `stub:${file}#${name}`,
    name,
    source: { file, startLine: 1, endLine: 2, startColumn: null, endColumn: null },
    bodyNode: {},
    fullNode: {},
  })
  return { ...candidate, ...rest }
}

/** A candidate named after `file`, which is all the workspace suites need to tell files apart. */
export function fileCandidate(
  file: string,
  overrides: Parameters<typeof stubCandidate>[1] = {},
): SymbolCandidate {
  return stubCandidate(file.replace(/[^A-Za-z0-9]/g, "_"), { file, ...overrides })
}

export type ScriptedStage = "extractSymbols" | "walkBody" | "normalizeAst"

export interface Script {
  /** What `parseFile` hands back as the tree; `null` is a plugin that could not build one. */
  tree?: ParsedTree | null
  parseErrors?: readonly ParseError[]
  /** Deliberately loose, so a test can hand back something no plugin should. */
  imports?: unknown
  /** Names of the candidates `extractSymbols` yields; one, `"one"`, by default. */
  candidates?: readonly string[]
  body?: BodyExtraction
  throwFrom?: ScriptedStage
  releaseThrows?: unknown
  /** Replaces the `releaseTree` method, for the plugins that break its contract. */
  releaseTreeOverride?: { value: unknown }
  parseMs?: number
  extractMs?: number
  walkMsPerCandidate?: number
}

/** A `.stub` language that spends the time it is told to and logs every call it receives. */
export class ScriptedLanguagePlugin implements LanguagePlugin {
  readonly manifest = langManifest()
  readonly languageId = makeLanguageId("stub")
  readonly fileExtensions = [".stub"]
  readonly capabilities = NO_CAPABILITIES
  readonly released: ParsedTree[] = []
  readonly order: string[] = []
  handedOut: ParsedTree | null = null

  constructor(private readonly script: Script = {}) {
    const override = script.releaseTreeOverride
    if (override !== undefined) {
      Object.defineProperty(this, "releaseTree", { value: override.value, enumerable: false })
    }
  }

  async init(): Promise<void> {}

  async parseFile(_file: SourceFile): Promise<ParseResult> {
    spend(this.script.parseMs ?? 0)
    this.handedOut = this.script.tree === undefined ? {} : this.script.tree
    return {
      tree: this.handedOut,
      errors: [...(this.script.parseErrors ?? [])],
      imports: ("imports" in this.script ? this.script.imports : []) as ImportEdge[],
    }
  }

  extractSymbols(_tree: ParsedTree, _ctx: ExtractionContext): SymbolCandidate[] {
    this.order.push("extractSymbols")
    spend(this.script.extractMs ?? 0)
    this.failIfAsked("extractSymbols")
    return (this.script.candidates ?? ["one"]).map((name) => stubCandidate(name))
  }

  walkBody(symbol: SymbolCandidate, _ctx: WalkContext): BodyExtraction {
    this.order.push(`walkBody:${symbol.name}`)
    spend(this.script.walkMsPerCandidate ?? 0)
    this.failIfAsked("walkBody")
    return this.script.body ?? EMPTY_BODY
  }

  normalizeAst(symbol: SymbolCandidate): string {
    this.order.push(`normalizeAst:${symbol.name}`)
    this.failIfAsked("normalizeAst")
    return "stub-ast"
  }

  releaseTree(tree: ParsedTree): void {
    this.order.push("releaseTree")
    this.released.push(tree)
    if (this.script.releaseThrows !== undefined) throw this.script.releaseThrows
  }

  private failIfAsked(stage: ScriptedStage): void {
    if (this.script.throwFrom === stage) throw new Error(`stub ${stage} exploded`)
  }
}

/** A scratch workspace holding `a.stub`, `bad.stub` and `c.stub`, each containing its own base name. */
export function useStubWorkspace(prefix: string): ScratchWorkspace {
  const workspace = useScratchWorkspace(prefix)
  beforeEach(async () => {
    for (const name of ["a", "bad", "c"]) await workspace.writeSource(`${name}.stub`, name)
  })
  return workspace
}

/** `runFilePipeline` over `stubFile` with an empty `.stub` language and nothing else loaded. */
export function runPipeline(
  overrides: Partial<FilePipelineInput> = {},
): Promise<FilePipelineResult> {
  const registry = overrides.registry ?? noopRegistry
  const config = overrides.config ?? {}
  return runFilePipeline({
    file: stubFile,
    language: stubLanguagePlugin(),
    frameworks: [],
    effects: [],
    registry,
    vocab: new VocabCheck(registry, isStrict(config)),
    config,
    dropCFilter: buildDropCFilter(),
    component: null,
    treeReleaseFailures: [],
    log: silentLogger,
    ...overrides,
  })
}

export function expectExtracted(result: FilePipelineResult): ExtractedFile {
  expect(result.kind).toBe("extracted")
  if (result.kind !== "extracted") throw new Error(`expected an extracted file, got ${result.kind}`)
  return result
}

export interface OneSymbolFile {
  candidate?: SymbolCandidate
  body?: BodyExtraction
  imports?: readonly ImportEdge[]
  frameworks?: readonly FrameworkPlugin[]
  effects?: readonly EffectPlugin[]
  language?: Partial<LanguagePlugin>
}

/** The pipeline over a file declaring one candidate (`stubCandidate("Fn")` by default). */
export async function extractOneSymbol(file: OneSymbolFile = {}): Promise<ExtractedFile> {
  const candidate = file.candidate ?? stubCandidate("Fn")
  const language = stubLanguagePlugin({
    parseFile: async () => ({ tree: {}, errors: [], imports: [...(file.imports ?? [])] }),
    extractSymbols: () => [candidate],
    walkBody: () => file.body ?? EMPTY_BODY,
    ...file.language,
  })
  const result = await runPipeline({
    language,
    frameworks: file.frameworks ?? [],
    effects: file.effects ?? [],
  })
  return expectExtracted(result)
}

/** `scan` over `workspaceRoot` with an empty `.stub` language and nothing else loaded. */
export function scanStubs(
  workspaceRoot: string,
  overrides: Partial<ScanInput> = {},
): Promise<ScanResult> {
  return scan({
    workspaceRoot,
    config: {},
    languages: [stubLanguagePlugin()],
    frameworks: [],
    effects: [],
    registry: noopRegistry,
    components: [],
    ...overrides,
  })
}
