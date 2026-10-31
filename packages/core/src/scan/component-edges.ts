import type { Component, ComponentId, Dependency, ImportEdge } from "@aburi/types"
import { dependencyKey } from "../call-site"
import { dirname, isRelativeSpecifier, joinPosix } from "../callgraph-specifier"
import { NPM_MANIFEST, type WorkspacePackage } from "../component-manifest"
import { compareCodeUnit } from "../order"
import { buildComponentAttribution, type ComponentAttribution } from "./attribute"

export interface ComponentImportEdgesInput {
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>
  /** Files the Document leaves out, whose imports are not its to report. */
  withdrawn: ReadonlySet<string>
  components: readonly Component[]
  packages: readonly WorkspacePackage[]
}

/** A package name an import used that the manifests of more than one Component declare. */
export interface ContestedPackageName {
  name: string
  components: ComponentId[]
}

export interface ComponentImportEdges {
  dependencies: Dependency[]
  contested: ContestedPackageName[]
}

type PackageClaims = ReadonlyMap<string, ReadonlySet<ComponentId>>

export function componentImportEdges(input: ComponentImportEdgesInput): ComponentImportEdges {
  const attribute = buildComponentAttribution(input.components)
  const claims = packageClaims(input.packages, attribute)
  const edges = new Map<string, Dependency>()
  const contested = new Set<string>()
  for (const [file, imports] of input.importsByFile) {
    if (input.withdrawn.has(file)) continue
    const from = attribute(file)
    if (from === null) continue
    for (const { source } of imports) {
      const specifier = withoutQuery(source)
      const to = isRelativeSpecifier(specifier)
        ? relativeOwner(file, specifier, attribute)
        : packageOwner(packageName(specifier), claims, contested)
      if (to === null || to === from) continue
      edges.set(dependencyKey(from, to, "import"), {
        from,
        to,
        via: "import",
        direction: "outbound",
        effect: null,
      })
    }
  }
  return {
    dependencies: [...edges.values()],
    contested: [...contested].sort(compareCodeUnit).map((name) => ({
      name,
      components: [...(claims.get(name) ?? [])].sort(compareCodeUnit),
    })),
  }
}

/** A bundler's `?raw` or `?inline` asks for the module in another form; the module is the same one. */
function withoutQuery(specifier: string): string {
  const query = specifier.indexOf("?")
  return query === -1 ? specifier : specifier.slice(0, query)
}

// The joined path need not be a file the scan read: a JSON module or a directory's index sits in
// the Component its path does.
function relativeOwner(
  file: string,
  specifier: string,
  attribute: ComponentAttribution,
): ComponentId | null {
  const target = joinPosix(dirname(file), specifier)
  if (target === null) return null
  // The workspace root directory names no file, but its index is one at the top level.
  return attribute(target === "" ? "index" : target)
}

function packageClaims(
  packages: readonly WorkspacePackage[],
  attribute: ComponentAttribution,
): PackageClaims {
  const claims = new Map<string, Set<ComponentId>>()
  for (const { name, root } of packages) {
    const owner = attribute(`${root}/${NPM_MANIFEST}`)
    if (owner === null) continue
    const claimants = claims.get(name)
    if (claimants === undefined) claims.set(name, new Set([owner]))
    else claimants.add(owner)
  }
  return claims
}

function packageName(specifier: string): string | null {
  const [first, second] = specifier.split("/")
  if (first === undefined || first.length === 0) return null
  if (!first.startsWith("@")) return first
  if (second === undefined || second.length === 0) return null
  return `${first}/${second}`
}

// A name two Components' manifests claim decides neither, so no arrow is drawn for it.
function packageOwner(
  name: string | null,
  claims: PackageClaims,
  contested: Set<string>,
): ComponentId | null {
  if (name === null) return null
  const claimants = claims.get(name)
  if (claimants === undefined) return null
  if (claimants.size > 1) {
    contested.add(name)
    return null
  }
  const [owner] = claimants
  return owner ?? null
}
