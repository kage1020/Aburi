import {
  type CallCandidate,
  type Confidence,
  type ImportBinding,
  type ImportEdge,
  PLUGIN_SCHEMA_URL,
} from "@aburi/types"

export type NonEmptySegments = readonly [string, ...string[]]

export interface PluginInputOrigin {
  /** Plugin name used as the message prefix, e.g. `"effects-drizzle"`. */
  readonly plugin: string
  /** Path of the source file the candidate came from. */
  readonly filePath: string
}

export type PluginInputErrorCode =
  /** `CallCandidate.target` is empty or has an empty segment. */
  | "unnormalized-callee"
  /** `ImportEdge.source` is empty. */
  | "unnormalized-import-source"
  /** An `ImportEdge.symbols` entry has an empty half. */
  | "unnormalized-import-binding"
  /** `ImportEdge.namespaceBinding` is empty. */
  | "unnormalized-namespace-binding"

/** A language plugin's output that breaks the contract the guard's caller reads it under. */
export class PluginInputError extends Error {
  readonly code: PluginInputErrorCode
  /** The plugin whose guard refused the value. */
  readonly plugin: string
  readonly filePath: string

  constructor(message: string, code: PluginInputErrorCode, origin: PluginInputOrigin) {
    super(message)
    this.name = "PluginInputError"
    this.code = code
    this.plugin = origin.plugin
    this.filePath = origin.filePath
  }
}

export interface CallTargetSegments {
  readonly segments: NonEmptySegments
  readonly last: string
}

export function assertNonEmptySegments(
  target: string,
  origin: PluginInputOrigin,
): CallTargetSegments {
  const where = `${origin.plugin} (${origin.filePath})`
  if (target.length === 0) {
    throw new PluginInputError(
      `${where}: CallCandidate.target is empty — language plugin emitted an unnormalized callee`,
      "unnormalized-callee",
      origin,
    )
  }

  const [first = "", ...rest] = target.split(".")

  const emptySegment = () =>
    new PluginInputError(
      `${where}: CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`,
      "unnormalized-callee",
      origin,
    )
  if (first.length === 0) throw emptySegment()

  let last = first
  for (const segment of rest) {
    if (segment.length === 0) throw emptySegment()
    last = segment
  }

  return { segments: [first, ...rest], last }
}

export function assertImportEdgeSource(edge: ImportEdge, origin: PluginInputOrigin): void {
  if (edge.source.length > 0) return
  throw new PluginInputError(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.source is empty — language plugin emitted an unnormalized import edge`,
    "unnormalized-import-source",
    origin,
  )
}

export type ImportBindingHalves = ImportBinding

export function assertImportBinding(
  binding: ImportBindingHalves,
  raw: string,
  edge: ImportEdge,
  origin: PluginInputOrigin,
): void {
  if (binding.imported.length > 0 && binding.local.length > 0) return
  throw new PluginInputError(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.symbols entry "${raw}" has an empty half — language plugin emitted an unnormalized import edge`,
    "unnormalized-import-binding",
    origin,
  )
}

export function assertNamespaceBinding(
  binding: string,
  edge: ImportEdge,
  origin: PluginInputOrigin,
): void {
  if (binding.length > 0) return
  throw new PluginInputError(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.namespaceBinding is empty — language plugin emitted an unnormalized import edge`,
    "unnormalized-namespace-binding",
    origin,
  )
}

export function hasMatchingImport(
  imports: readonly ImportEdge[],
  origin: PluginInputOrigin,
  matches: (source: string) => boolean,
): boolean {
  for (const edge of imports) assertImportEdgeSource(edge, origin)
  return imports.some((edge) => matches(edge.source))
}

export function identifierWords(name: string): string[] {
  const words: string[] = []
  for (const chunk of name.split(/[^A-Za-z0-9]+/)) {
    for (const word of chunk.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []) {
      words.push(word.toLowerCase())
    }
  }
  return words
}

export function identifierMentions(name: string, vocabulary: ReadonlySet<string>): boolean {
  return identifierWords(name).some((word) => vocabulary.has(word))
}

export function hasLiteralFirstArgument(call: Pick<CallCandidate, "literalArgs">): boolean {
  return (call.literalArgs[0] ?? null) !== null
}

export function matchesModuleOrSubpath(...roots: readonly string[]): (source: string) => boolean {
  return (source) => roots.some((root) => source === root || source.startsWith(`${root}/`))
}

export function receiverConfidence(
  clientSegment: string | undefined,
  call: Pick<CallCandidate, "dynamicReceiver" | "argumentCount">,
  maxArguments: number,
  namesClient: (segment: string) => boolean,
): Confidence {
  if (call.dynamicReceiver === true) return "medium"
  if (call.argumentCount > maxArguments) return "medium"
  if (clientSegment !== undefined && namesClient(clientSegment)) return "high"
  return "medium"
}

export interface EffectsPluginManifest<Name extends string, DerivedByPrefix extends string> {
  readonly $schema: typeof PLUGIN_SCHEMA_URL
  readonly name: Name
  readonly version: "0.0.0"
  readonly type: "effects"
  readonly engines: { readonly aburi: "*" }
  readonly provides: {
    readonly effects: []
    readonly effectPrefixes: []
    readonly extKinds: []
    readonly extKindPrefixes: []
    readonly derivedByPrefixes: [DerivedByPrefix]
    readonly frameworks: []
  }
}

export function defineEffectsManifest<Name extends string, DerivedByPrefix extends string>(
  name: Name,
  derivedByPrefix: DerivedByPrefix,
): EffectsPluginManifest<Name, DerivedByPrefix> {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name,
    version: "0.0.0",
    type: "effects",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [derivedByPrefix],
      frameworks: [],
    },
  }
}
