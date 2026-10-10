import type { CallCandidate, Confidence, ImportEdge } from "@aburi/types"

export type NonEmptySegments = readonly [string, ...string[]]

export interface PluginInputOrigin {
  /** Plugin name used as the message prefix, e.g. `"effects-drizzle"`. */
  readonly plugin: string
  /** Path of the source file the candidate came from. */
  readonly filePath: string
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
    throw new Error(
      `${where}: CallCandidate.target is empty — language plugin emitted an unnormalized callee`,
    )
  }

  const [first = "", ...rest] = target.split(".")

  const emptySegment = `${where}: CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`
  if (first.length === 0) throw new Error(emptySegment)

  let last = first
  for (const segment of rest) {
    if (segment.length === 0) throw new Error(emptySegment)
    last = segment
  }

  return { segments: [first, ...rest], last }
}

export function assertImportEdgeSource(edge: ImportEdge, origin: PluginInputOrigin): void {
  if (edge.source.length > 0) return
  throw new Error(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.source is empty — language plugin emitted an unnormalized import edge`,
  )
}

export interface ImportBindingHalves {
  readonly imported: string
  readonly local: string
}

export function assertImportBinding(
  binding: ImportBindingHalves,
  raw: string,
  edge: ImportEdge,
  origin: PluginInputOrigin,
): void {
  if (binding.imported.length > 0 && binding.local.length > 0) return
  throw new Error(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.symbols entry "${raw}" has an empty half — language plugin emitted an unnormalized import edge`,
  )
}

export function assertNamespaceBinding(
  binding: string,
  edge: ImportEdge,
  origin: PluginInputOrigin,
): void {
  if (binding.length > 0) return
  throw new Error(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.namespaceBinding is empty — language plugin emitted an unnormalized import edge`,
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
  readonly $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json"
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
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
