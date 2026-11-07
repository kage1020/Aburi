import type {
  ImportEdge,
  ImportResolver,
  LanguagePlugin,
  OpaqueAstNode,
  SourceFile,
  SymbolCandidate,
} from "@aburi/types"
import { AsyncMemo } from "../async-memo"
import {
  DEFAULT_EXTENSIONS,
  dirname,
  isRelativeSpecifier,
  resolveRelativeSpecifier,
} from "../callgraph-specifier"
import { toNfc } from "../codepoints"
import { decoratorReference, splitAliasedImportName } from "../import-edge"
import type { DiscoveredFile } from "./discover"
import { type ExtractionEvent, edgesReadOnce, eventLogger } from "./extraction-events"
import { describeJsonType, describeThrown } from "./faults"
import { normalizeImportEdge } from "./normalize"
import { releaseParsedTree, type TreeReleaseFailure } from "./pipeline"
import type { LanguageRouter } from "./route"

type Language = LanguagePlugin<unknown, unknown>

export interface ImportOriginsInput {
  workspaceRoot: string
  files: readonly DiscoveredFile[]
  router: LanguageRouter
  loadSource(file: DiscoveredFile): Promise<SourceFile>
  record(event: ExtractionEvent): void
}

interface Hop {
  readonly source: string
  readonly imported: string
}

/** Where a specifier leads: a workspace file, out of the workspace, or nowhere the resolver could say. */
type Target = { readonly file: string } | "outside" | "fault"

const NAMESPACE = "*"

// Only the names decorators bind are followed: an origin for every import would parse most of the
// workspace twice.
export class ImportOrigins {
  readonly #input: ImportOriginsInput
  readonly #files: ReadonlyMap<string, DiscoveredFile>
  readonly #knownFiles: ReadonlySet<string>
  readonly #resolvers = new Map<Language, ImportResolver | "none" | "fault">()
  readonly #edges = new AsyncMemo<string, readonly ImportEdge[]>()
  readonly #targets = new AsyncMemo<string, Target>()

  constructor(input: ImportOriginsInput) {
    this.#input = input
    this.#files = new Map(input.files.map((file) => [file.path, file]))
    this.#knownFiles = new Set(this.#files.keys())
  }

  remember(path: string, edges: readonly ImportEdge[]): void {
    this.#edges.prime(path, edges)
  }

  async attach(
    file: SourceFile,
    imports: readonly ImportEdge[],
    candidates: readonly SymbolCandidate<OpaqueAstNode>[],
  ): Promise<readonly ImportEdge[]> {
    const originsByEdge = new Map<ImportEdge, Map<string, string>>()
    for (const [edge, names] of decoratorBindings(imports, candidates)) {
      const origins = new Map<string, string>()
      for (const name of names) {
        const origin = await this.#externalOrigin(file.path, edge.source, name)
        if (origin !== null && origin !== edge.source) origins.set(name, origin)
      }
      if (origins.size > 0) originsByEdge.set(edge, origins)
    }
    if (originsByEdge.size === 0) return imports
    return imports.map((edge) => {
      const origins = originsByEdge.get(edge)
      return origins === undefined ? edge : { ...edge, origins }
    })
  }

  async #externalOrigin(fromFile: string, specifier: string, name: string): Promise<string | null> {
    const visited = new Set<string>()
    let hop: Hop = { source: specifier, imported: name }
    let from = fromFile
    for (;;) {
      const source = hop.source
      const key = `${from}\0${source}`
      const target = await this.#targets.get(key, () => this.#resolveTarget(from, source, key))
      if (target === "fault") return null
      if (target === "outside") return isRelativeSpecifier(hop.source) ? null : hop.source
      // A namespace of a workspace module: which member the decorator reads is not carried here.
      if (hop.imported === NAMESPACE) return null
      const state = `${target.file}\0${hop.imported}`
      if (visited.has(state)) return null
      visited.add(state)
      const file = target.file
      const next = reexportOf(
        await this.#edges.get(file, () => this.#readEdges(file)),
        hop.imported,
      )
      if (next === null) return null
      from = file
      hop = next
    }
  }

  async #resolveTarget(fromFile: string, specifier: string, key: string): Promise<Target> {
    if (isRelativeSpecifier(specifier)) return this.#fileOrOutside(dirname(fromFile), specifier)
    const language = this.#input.router.route(fromFile)
    if (language === null) return "outside"
    const resolver = this.#resolverFor(language)
    if (resolver === "none") return "outside"
    if (resolver === "fault") return "fault"
    try {
      for (const path of await resolver.resolve(specifier, fromFile)) {
        const found = typeof path === "string" ? this.#probe("", toNfc(path)) : null
        if (found !== null) return { file: found }
      }
    } catch (error) {
      this.#fault(
        language,
        `its import resolver threw on "${specifier}" in ${fromFile}`,
        error,
        `target\0${key}`,
      )
      return "fault"
    }
    return "outside"
  }

  #fileOrOutside(fromDirectory: string, specifier: string): Target {
    const found = this.#probe(fromDirectory, specifier)
    return found === null ? "outside" : { file: found }
  }

  #resolverFor(language: Language): ImportResolver | "none" | "fault" {
    let resolver = this.#resolvers.get(language)
    if (resolver === undefined) {
      resolver = this.#createResolver(language)
      this.#resolvers.set(language, resolver)
    }
    return resolver
  }

  #createResolver(language: Language): ImportResolver | "none" | "fault" {
    if (typeof language.createImportResolver !== "function") return "none"
    const plugin = language.manifest.name
    const once = `resolver\0${plugin}`
    let created: unknown
    try {
      created = language.createImportResolver({
        workspaceRoot: this.#input.workspaceRoot,
        log: eventLogger((level, message, meta) =>
          this.#input.record({
            kind: "resolver-log",
            plugin,
            level,
            message,
            ...(meta === undefined ? {} : { meta }),
          }),
        ),
      })
    } catch (error) {
      this.#fault(language, "creating its import resolver threw", error, once)
      return "fault"
    }
    if (isImportResolver(created)) return created
    this.#fault(
      language,
      "createImportResolver returned no resolver",
      new TypeError(`expected an object with a resolve method, got ${describeJsonType(created)}`),
      once,
    )
    return "fault"
  }

  #probe(fromDirectory: string, specifier: string): string | null {
    return resolveRelativeSpecifier({
      fromDirectory,
      specifier,
      extensions: DEFAULT_EXTENSIONS,
      knownFiles: this.#knownFiles,
    })
  }

  async #readEdges(path: string): Promise<readonly ImportEdge[]> {
    const discovered = this.#files.get(path)
    const language = this.#input.router.route(path)
    if (discovered === undefined || language === null) return []
    const once = edgesReadOnce(path)
    try {
      const file = await this.#input.loadSource(discovered)
      const parsed = await language.parseFile(file)
      if (parsed.tree !== null) {
        const failures: TreeReleaseFailure[] = []
        releaseParsedTree(language, parsed.tree, file, failures)
        for (const failure of failures) {
          this.#input.record({ kind: "tree-release-failure", failure, once })
        }
      }
      return parsed.imports.map(normalizeImportEdge)
    } catch (error) {
      // The file's own turn in the scan reports the fault; here it only ends the chain.
      this.#input.record({
        kind: "log",
        level: "debug",
        message: `scan/import-origins: ${path} gave no import edges: ${describeThrown(error)}`,
        once,
      })
      return []
    }
  }

  #fault(language: Language, what: string, error: unknown, once: string): void {
    const plugin = language.manifest.name
    const message = `Plugin ${plugin}: ${what}: ${describeThrown(error)}.`
    this.#input.record({ kind: "resolver-fault", plugin, message, once })
  }
}

function isImportResolver(value: unknown): value is ImportResolver {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { resolve?: unknown }).resolve === "function"
  )
}

function decoratorBindings(
  imports: readonly ImportEdge[],
  candidates: readonly SymbolCandidate<OpaqueAstNode>[],
): Map<ImportEdge, Set<string>> {
  const wanted = new Map<ImportEdge, Set<string>>()
  const want = (edge: ImportEdge, name: string): void => {
    const names = wanted.get(edge)
    if (names === undefined) wanted.set(edge, new Set([name]))
    else names.add(name)
  }
  for (const candidate of candidates) {
    for (const decorator of candidate.decorators) {
      const { head, member } = decoratorReference(decorator)
      for (const edge of imports) {
        if (edge.dynamic) continue
        if (edge.symbols === "*") {
          if (decorator.qualifier !== undefined && edge.namespaceBinding === head) {
            want(edge, member)
          }
          continue
        }
        for (const raw of edge.symbols) {
          const binding = splitAliasedImportName(raw)
          if (binding.local === head) want(edge, binding.imported)
        }
      }
    }
  }
  return wanted
}

function reexportOf(edges: readonly ImportEdge[], name: string): Hop | null {
  for (const edge of edges) {
    if (edge.dynamic) continue
    const reexport = edge.reexports?.find((entry) => entry.exported === name)
    if (reexport !== undefined) return { source: edge.source, imported: reexport.imported }
  }
  return null
}
