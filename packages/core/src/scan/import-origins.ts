import type {
  ImportEdge,
  ImportResolver,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  SourceFile,
  SymbolCandidate,
} from "@aburi/types"
import {
  DEFAULT_EXTENSIONS,
  dirname,
  isRelativeSpecifier,
  resolveRelativeSpecifier,
} from "../callgraph-specifier"
import { toNfc } from "../codepoints"
import { splitAliasedImportName } from "../import-edge"
import type { DiscoveredFile } from "./discover"
import { describeThrown } from "./faults"
import { normalizeImportEdge } from "./normalize"
import { releaseParsedTree, type TreeReleaseFailure } from "./pipeline"
import type { LanguageRouter } from "./route"

type Language = LanguagePlugin<unknown, unknown>

export interface ImportOriginsInput {
  workspaceRoot: string
  files: readonly DiscoveredFile[]
  router: LanguageRouter
  logger: Logger
  loadSource(file: DiscoveredFile): Promise<SourceFile>
  treeReleaseFailures: TreeReleaseFailure[]
}

interface Hop {
  readonly source: string
  readonly imported: string
}

// Only the names decorators bind are followed: an origin for every import would parse most of the
// workspace twice.
export class ImportOrigins {
  readonly #input: ImportOriginsInput
  readonly #files: ReadonlyMap<string, DiscoveredFile>
  readonly #knownFiles: ReadonlySet<string>
  readonly #resolvers = new Map<Language, ImportResolver | null>()
  readonly #edges = new Map<string, Promise<readonly ImportEdge[]>>()
  readonly #targets = new Map<string, Promise<string | null>>()
  readonly #warned = new Set<string>()

  constructor(input: ImportOriginsInput) {
    this.#input = input
    this.#files = new Map(input.files.map((file) => [file.path, file]))
    this.#knownFiles = new Set(this.#files.keys())
  }

  remember(path: string, edges: readonly ImportEdge[]): void {
    if (!this.#edges.has(path)) this.#edges.set(path, Promise.resolve(edges))
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
      const target = await this.#target(from, hop.source)
      if (target === null) return isRelativeSpecifier(hop.source) ? null : hop.source
      const state = `${target}\0${hop.imported}`
      if (visited.has(state)) return null
      visited.add(state)
      const next = reexportOf(await this.#edgesOf(target), hop.imported)
      if (next === null) return null
      from = target
      hop = next
    }
  }

  #target(fromFile: string, specifier: string): Promise<string | null> {
    const key = `${fromFile}\0${specifier}`
    let target = this.#targets.get(key)
    if (target === undefined) {
      target = this.#resolveTarget(fromFile, specifier)
      this.#targets.set(key, target)
    }
    return target
  }

  async #resolveTarget(fromFile: string, specifier: string): Promise<string | null> {
    if (isRelativeSpecifier(specifier)) return this.#probe(dirname(fromFile), specifier)
    const language = this.#input.router.route(fromFile)
    if (language === null) return null
    const resolver = this.#resolverFor(language)
    if (resolver === null) return null
    try {
      for (const path of await resolver.resolve(specifier, fromFile)) {
        const found = typeof path === "string" ? this.#probe("", toNfc(path)) : null
        if (found !== null) return found
      }
    } catch (error) {
      this.#warnOnce(language, `its import resolver threw on "${specifier}" in ${fromFile}`, error)
    }
    return null
  }

  #resolverFor(language: Language): ImportResolver | null {
    if (this.#resolvers.has(language)) return this.#resolvers.get(language) ?? null
    let resolver: ImportResolver | null = null
    if (typeof language.createImportResolver === "function") {
      try {
        resolver = language.createImportResolver({
          workspaceRoot: this.#input.workspaceRoot,
          log: this.#input.logger,
        })
      } catch (error) {
        this.#warnOnce(language, "creating its import resolver threw", error)
      }
    }
    this.#resolvers.set(language, resolver)
    return resolver
  }

  #probe(fromDirectory: string, specifier: string): string | null {
    return resolveRelativeSpecifier({
      fromDirectory,
      specifier,
      extensions: DEFAULT_EXTENSIONS,
      knownFiles: this.#knownFiles,
    })
  }

  #edgesOf(path: string): Promise<readonly ImportEdge[]> {
    let edges = this.#edges.get(path)
    if (edges === undefined) {
      edges = this.#readEdges(path)
      this.#edges.set(path, edges)
    }
    return edges
  }

  async #readEdges(path: string): Promise<readonly ImportEdge[]> {
    const discovered = this.#files.get(path)
    const language = this.#input.router.route(path)
    if (discovered === undefined || language === null) return []
    try {
      const file = await this.#input.loadSource(discovered)
      const parsed = await language.parseFile(file)
      if (parsed.tree !== null) {
        releaseParsedTree(language, parsed.tree, file, this.#input.treeReleaseFailures)
      }
      return parsed.imports.map(normalizeImportEdge)
    } catch (error) {
      // The file's own turn in the scan reports the fault; here it only ends the chain.
      this.#input.logger.debug(
        `scan/import-origins: ${path} gave no import edges: ${describeThrown(error)}`,
      )
      return []
    }
  }

  #warnOnce(language: Language, what: string, error: unknown): void {
    const plugin = language.manifest.name
    if (this.#warned.has(plugin)) return
    this.#warned.add(plugin)
    this.#input.logger.warn(
      `Plugin ${plugin}: ${what}: ${describeThrown(error)}. A name imported through one of its ` +
        "path aliases is attributed to the specifier as written.",
    )
  }
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
      const qualifier = decorator.qualifier
      const segments = qualifier === undefined ? [] : qualifier.split(".")
      const local = segments[0] ?? decorator.name
      const member = segments[1] ?? decorator.name
      for (const edge of imports) {
        if (edge.dynamic) continue
        if (edge.symbols === "*") {
          if (qualifier !== undefined && edge.namespaceBinding === local) want(edge, member)
          continue
        }
        for (const raw of edge.symbols) {
          const binding = splitAliasedImportName(raw)
          if (binding.local === local) want(edge, binding.imported)
        }
      }
    }
  }
  return wanted
}

// A re-export records the name it takes from its source, so the name a barrel exports and the
// local an import binds are looked up alike.
function reexportOf(edges: readonly ImportEdge[], name: string): Hop | null {
  for (const edge of edges) {
    if (edge.dynamic || edge.symbols === "*") continue
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      if (binding.local === name) return { source: edge.source, imported: binding.imported }
    }
  }
  return null
}
