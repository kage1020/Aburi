import type {
  BodyExtraction,
  EffectsManifest,
  FrameworkManifest,
  LangManifest,
  LanguageCapabilities,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParseResult,
  PluginManifest,
  SourceFile,
  SymbolCandidate,
} from "@aburi/types"
import { symbolId } from "./ir"

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

export function frameworkManifest(name = "framework-stub"): FrameworkManifest {
  return manifest("framework", name)
}

export function effectsManifest(name = "effects-stub"): EffectsManifest {
  return manifest("effects", name)
}

/** A language that claims nothing. */
export const NO_CAPABILITIES: LanguageCapabilities = {
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

export const EMPTY_BODY: BodyExtraction = { rules: [], calls: [] }

/** The one file a `.stub` plugin is handed when the test is not about the file. */
export const stubFile: SourceFile = { path: "test.stub", content: "" }

/**
 * A `.stub` language plugin whose every stage is a no-op (an empty tree, no candidates, an
 * empty body, `"stub-ast"`), with `overrides` layered on top. `languageId` is widened so a
 * case can write the literal `"stub"`; production plugins go through `makeLanguageId`.
 */
export function stubLanguagePlugin(
  overrides: Omit<Partial<LanguagePlugin>, "languageId"> & { languageId?: string } = {},
): LanguagePlugin {
  const plugin = {
    manifest: langManifest(),
    languageId: "stub",
    fileExtensions: [".stub"],
    capabilities: NO_CAPABILITIES,
    init: async () => {},
    parseFile: async (): Promise<ParseResult> => ({
      tree: {} as OpaqueAstNode,
      errors: [],
      imports: [],
    }),
    extractSymbols: () => [],
    walkBody: () => EMPTY_BODY,
    normalizeAst: () => "stub-ast",
    ...overrides,
  }
  return plugin as unknown as LanguagePlugin
}

/**
 * A function candidate in `file` (default `test.stub`) named `name`, with a schema-satisfying
 * default for everything else. The id is `stub:<file>#<name>` unless overridden.
 */
export function stubCandidate(
  name: string,
  overrides: Omit<Partial<SymbolCandidate<OpaqueAstNode>>, "id"> & {
    id?: string
    file?: string
  } = {},
): SymbolCandidate<OpaqueAstNode> {
  const { id, file = "test.stub", ...rest } = overrides
  return {
    id: symbolId(id ?? `stub:${file}#${name}`),
    kind: "function",
    extKind: null,
    name,
    visibility: "public",
    decorators: [],
    signature: null,
    source: { file, startLine: 1, endLine: 2, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
    ...rest,
  }
}

export interface CapturedLine {
  message: string
  meta: Record<string, unknown> | undefined
}

/** A `Logger` that records what it is told, one array per level. */
export function capturingLogger(): {
  logger: Logger
  warnings: string[]
  debugs: CapturedLine[]
} {
  const warnings: string[] = []
  const debugs: CapturedLine[] = []
  return {
    warnings,
    debugs,
    logger: {
      debug: (message: string, meta?: Record<string, unknown>) => debugs.push({ message, meta }),
      info: () => {},
      warn: (message: string) => warnings.push(message),
      error: () => {},
    },
  }
}
