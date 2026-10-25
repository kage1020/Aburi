import type { Component, ComponentId, Dependency, ImportEdge } from "@aburi/types"
import { dependencyKey } from "../call-site"
import { dirname, isRelativeSpecifier, joinPosix } from "../callgraph-specifier"
import { NPM_MANIFEST, type WorkspacePackage } from "../component-manifest"
import { buildComponentAttribution, type ComponentAttribution } from "./attribute"

export interface ComponentImportEdgesInput {
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>
  /** Files the Document leaves out, whose imports are not its to report. */
  withdrawn: ReadonlySet<string>
  components: readonly Component[]
  packages: readonly WorkspacePackage[]
}

export function componentImportEdges(input: ComponentImportEdgesInput): Dependency[] {
  const attribute = buildComponentAttribution(input.components)
  const packages = packageOwners(input.packages, attribute)
  const edges = new Map<string, Dependency>()
  for (const [file, imports] of input.importsByFile) {
    if (input.withdrawn.has(file)) continue
    const from = attribute(file)
    if (from === null) continue
    for (const { source } of imports) {
      const to = isRelativeSpecifier(source)
        ? relativeOwner(file, source, attribute)
        : packageOwner(source, packages)
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
  return [...edges.values()]
}

// The joined path need not be a file the scan read: a JSON module or a directory's index sits in
// the Component its path does.
function relativeOwner(
  file: string,
  specifier: string,
  attribute: ComponentAttribution,
): ComponentId | null {
  const target = joinPosix(dirname(file), specifier)
  return target === null ? null : attribute(target)
}

function packageOwners(
  packages: readonly WorkspacePackage[],
  attribute: ComponentAttribution,
): Map<string, ComponentId> {
  const owners = new Map<string, ComponentId | null>()
  for (const { name, root } of packages) {
    const owner = attribute(`${root}/${NPM_MANIFEST}`)
    if (owner === null) continue
    const claimed = owners.get(name)
    // A name two Components' manifests claim decides neither, so no arrow is drawn for it.
    owners.set(name, claimed === undefined || claimed === owner ? owner : null)
  }
  const resolved = new Map<string, ComponentId>()
  for (const [name, owner] of owners) if (owner !== null) resolved.set(name, owner)
  return resolved
}

function packageOwner(
  specifier: string,
  packages: ReadonlyMap<string, ComponentId>,
): ComponentId | null {
  const [first, second] = specifier.split("/")
  if (first === undefined || first.length === 0) return null
  if (!first.startsWith("@")) return packages.get(first) ?? null
  if (second === undefined || second.length === 0) return null
  return packages.get(`${first}/${second}`) ?? null
}
