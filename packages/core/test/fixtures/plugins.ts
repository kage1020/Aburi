import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { afterEach, beforeEach } from "vitest"
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

/**
 * A scratch workspace of three `.stub` files, `a` / `bad` / `c`, torn down after each test.
 *
 * Three rather than one because the tests that use it are about blast radius: a check that
 * withdrew the run rather than the offending file shows up as a missing `a.stub` *and* a
 * missing `c.stub`, one either side of `bad.stub` in discovery order (which is ascending by
 * path). The names are load-bearing for that reason, so the caller does not choose them.
 *
 * Call it at the top of a `describe`; it registers its own `beforeEach` / `afterEach` and
 * hands back an object whose `root` is the current test's directory.
 */
export function useStubWorkspace(prefix: string): { readonly root: string } {
  const handle = { root: "" }
  beforeEach(async () => {
    handle.root = await mkdtemp(join(tmpdir(), `aburi-${prefix}-`))
    await writeFile(join(handle.root, "a.stub"), "a", "utf8")
    await writeFile(join(handle.root, "bad.stub"), "bad", "utf8")
    await writeFile(join(handle.root, "c.stub"), "c", "utf8")
  })
  afterEach(async () => {
    await rm(handle.root, { recursive: true, force: true })
  })
  return handle
}
