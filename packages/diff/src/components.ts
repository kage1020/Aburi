import type {
  Component,
  ComponentDiff,
  ComponentId,
  Dependency,
  DependencyDiff,
  DependencyEndpoint,
  DependencyUnknown,
  DiffSkippedFile,
  IR,
  RelativePath,
  SkipReason,
} from "@aburi/types"

/**
 * `docs/design/diff-algorithm.md` §6.1 — Component diff. Assumes `components[].id` is unique on each side (ir-schema.md §14
 * #2) and does not check it: `buildDiff` establishes that before calling, and a caller
 * reaching this export directly owns the obligation, because the lookup map here is
 * last-write-wins and a repeat is lost rather than reported.
 *
 * Component identity is `id`; when a Component is present in both
 * base and head with the same id, the three delta booleans describe which axes actually
 * moved (roots reshuffle, public API globs, or framework hint list). `modified` deltas
 * are intentionally absent from this diff (diff-algorithm.md §5.2.3): fields are reported as before/after
 * pairs via the `changed[]` entries so consumers can render them without stringifying
 * arrays.
 */
export function diffComponents(
  base: readonly Component[],
  head: readonly Component[],
): ComponentDiff {
  const baseById = new Map<ComponentId, Component>()
  for (const c of base) baseById.set(c.id, c)
  const headById = new Map<ComponentId, Component>()
  for (const c of head) headById.set(c.id, c)

  const added: Component[] = []
  const removed: Component[] = []
  const changed: ComponentDiff["changed"] = []

  for (const [id, headComp] of headById) {
    const baseComp = baseById.get(id)
    if (baseComp === undefined) {
      added.push(headComp)
      continue
    }
    const rootsChanged = !stringArraysEqual(baseComp.roots, headComp.roots)
    const publicApiChanged = !stringArraysEqual(baseComp.publicApi ?? [], headComp.publicApi ?? [])
    const frameworksChanged = !stringArraysEqual(
      baseComp.frameworks ?? [],
      headComp.frameworks ?? [],
    )
    if (rootsChanged || publicApiChanged || frameworksChanged) {
      changed.push({
        before: baseComp,
        after: headComp,
        delta: { rootsChanged, publicApiChanged, frameworksChanged },
      })
    }
  }
  for (const [id, baseComp] of baseById) {
    if (!headById.has(id)) removed.push(baseComp)
  }
  sortById(added)
  sortById(removed)
  changed.sort((a, b) => (a.after.id < b.after.id ? -1 : a.after.id > b.after.id ? 1 : 0))
  return { added, removed, changed }
}

/**
 * What one document knows about itself, for deciding whether the *other* document's silence
 * about an edge is evidence.
 *
 * `symbolFiles` is keyed on the endpoint id exactly as `dependencies[]` spells it, and its
 * values come from `symbols[].source.file` — the same space `stats.skippedFiles[].path` is in,
 * and the same space `buildDiff` classifies Symbols by. Reading the file out of the id's path
 * segment instead would introduce a second answer to "which file is this endpoint in", and
 * nothing in the schema forces the two to agree; a Symbol reported `unknown` while its edges
 * stayed `removed` is precisely the inconsistency this exists to remove.
 *
 * A Component endpoint is absent from the map, which is how it stays out of the reclassification
 * without a special case: a Component is an aggregate over roots and has no file to lose.
 */
export interface DependencySideView {
  /**
   * `source.file` of every Symbol this document holds, by the id an endpoint would name it
   * with. Keyed by `DependencyEndpoint` rather than `SymbolId` because that is the question
   * being asked: the lookup happens with an endpoint whose kind is not yet known, and "absent"
   * is the answer for a Component id. Demanding the kind up front would move that decision to
   * the caller, where it would need a second Symbol-id silhouette test to make.
   */
  symbolFiles: ReadonlyMap<DependencyEndpoint, RelativePath>
  /**
   * Files this document never analysed, by path, with the reason it gave. `RelativePath` on
   * both sides of the file space is what states the bridge these two maps exist to make — one
   * map's values are the other's keys — though the alias is unbranded, so it is intent rather
   * than enforcement.
   */
  lostFiles: ReadonlyMap<RelativePath, SkipReason>
}

/**
 * Build a side view from a document. The only construction site there is.
 *
 * `buildDiff` reads `lostFiles` for its own Symbol classification too, from this same object,
 * so "a Symbol reported unknown and the edges it took with it cannot disagree about which file
 * went missing" is a property of the wiring rather than a claim in a comment.
 *
 * Exported because `DependencySideView` is public and `diffDependencies` requires one: without
 * a factory a caller would have to reproduce the `symbols[].source.file` keying and the
 * `stats.skippedFiles` read, and the likeliest outcome of that is a caller who gets it wrong.
 */
export function dependencySideView(ir: IR): DependencySideView {
  const symbolFiles = new Map<DependencyEndpoint, RelativePath>()
  for (const symbol of ir.symbols) symbolFiles.set(symbol.id, symbol.source.file)
  const lostFiles = new Map<RelativePath, SkipReason>()
  for (const file of ir.stats.skippedFiles ?? []) lostFiles.set(file.path, file.reason)
  return { symbolFiles, lostFiles }
}

/**
 * `docs/design/diff-algorithm.md` §6.2 — Dependency diff. Identity is the composite
 * `(from, to, via)` triple; direction and effect changes are surfaced as an added + removed
 * pair so `modified` is not part of the schema (§6.2 tail). Uniqueness of that triple is the caller's obligation on the same
 * terms as `diffComponents` above — a repeat here is indistinguishable in the output from
 * the flip it encodes.
 *
 * `sides` is what separates a deletion from a loss (`docs/design/diff-algorithm.md` §6.2.1).
 * It is required rather than optional: omitting it would classify every edge into a lost file
 * as a deletion again — silently, and while still writing `unknown: []`, which this schema
 * defines as "nothing was unknown" rather than "nobody looked". A caller with no skip list to
 * offer says so by passing a side view whose `lostFiles` is empty, which is the honest spelling
 * of an IR written before `stats.skippedFiles` existed.
 *
 * The return type declares `unknown` present, where the schema leaves it optional for documents
 * that predate the field. A reader may find it missing; this function always writes it.
 */
export function diffDependencies(
  base: readonly Dependency[],
  head: readonly Dependency[],
  sides: { base: DependencySideView; head: DependencySideView },
): DependencyDiff & { unknown: DependencyUnknown[] } {
  const baseKeys = new Map<string, Dependency>()
  for (const d of base) baseKeys.set(dependencyKey(d), d)
  const headKeys = new Map<string, Dependency>()
  for (const d of head) headKeys.set(dependencyKey(d), d)
  const added: Dependency[] = []
  const removed: Dependency[] = []
  const unknown: DependencyUnknown[] = []
  for (const [key, dep] of headKeys) {
    const b = baseKeys.get(key)
    if (b === undefined) {
      // Held by head and not by base, so its endpoints resolve against head — the document
      // that has the Symbols — and the question is whether base could have seen them.
      const lostFiles = endpointsLostBy(dep, sides.head, sides.base)
      if (lostFiles.length > 0) unknown.push({ dependency: dep, absentFrom: "base", lostFiles })
      else added.push(dep)
      continue
    }
    // A direction or effect flip. No loss check: both documents hold the edge, so neither is
    // silent about it, and `unknown` exists only to explain a silence. That holds without
    // appealing to any invariant — nothing forbids a path from being both a `source.file` and a
    // skipped one, so "they both have it, therefore neither lost the file" would not be sound.
    if (b.direction !== dep.direction || (b.effect ?? null) !== (dep.effect ?? null)) {
      removed.push(b)
      added.push(dep)
    }
  }
  for (const [key, dep] of baseKeys) {
    if (headKeys.has(key)) continue
    const lostFiles = endpointsLostBy(dep, sides.base, sides.head)
    if (lostFiles.length > 0) unknown.push({ dependency: dep, absentFrom: "head", lostFiles })
    else removed.push(dep)
  }
  added.sort(compareDependencies)
  removed.sort(compareDependencies)
  unknown.sort((a, b) => compareDependencies(a.dependency, b.dependency))
  return { added, removed, unknown }
}

/**
 * The endpoint files `absent` never analysed, read through `holder` because that is the
 * document the edge — and therefore the Symbol behind each endpoint — actually comes from.
 *
 * Both endpoints are checked: an edge dies when *either* end's file goes, including one whose
 * other end survived, and that half is the easiest to miss because the surviving Symbol is
 * right there in both documents.
 *
 * Deduped and sorted by path, so an intra-file edge collapses to the one file it lost.
 */
function endpointsLostBy(
  dep: Dependency,
  holder: DependencySideView,
  absent: DependencySideView,
): DiffSkippedFile[] {
  // Keyed by path, so an intra-file edge collapses to the one file it lost. Keying by reason
  // instead would look identical on every fixture whose two endpoints were skipped for
  // different reasons, and silently drop one of two files skipped for the same reason.
  const byPath = new Map<RelativePath, SkipReason>()
  for (const endpoint of [dep.from, dep.to]) {
    const file = holder.symbolFiles.get(endpoint)
    // Normally a Component endpoint: an aggregate over roots, with no file to lose, which is
    // why component-level edges need no special case to stay out of this.
    //
    // The other way to land here is a symbol-shaped endpoint with no Symbol behind it, which
    // `ir-schema.md` §14 #4 forbids. `buildDiff` does not run the integrity checker, and the
    // CLI cannot reach it because `readIR` rejects such a document first — so this is a library
    // caller who assembled an IR by hand, and the edge quietly reverts to the misclassification
    // this function exists to remove. Treated the same as a Component endpoint deliberately:
    // there is no diagnostics channel here, and refusing would take down the legitimate case
    // that shares the branch.
    if (file === undefined) continue
    const reason = absent.lostFiles.get(file)
    if (reason === undefined) continue
    byPath.set(file, reason)
  }
  return [...byPath.entries()]
    .map(([path, reason]) => ({ path, reason }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * `docs/design/diff-algorithm.md` §6.2 — the fields Dependency identity is made of, in key order, and the join that turns
 * them into one. Both halves are exported so the entry-point uniqueness check keys on
 * exactly what this file keys on — a check with its own notion of identity would let through
 * the duplicates that actually collide here, and a check that shared only the join would
 * still be free to disagree about which fields identity is made of.
 *
 * Core's invariant #13 joins the same triple with a different separator. The two agree for
 * every endpoint that satisfies the id grammars of ir-schema.md §3.1 and §4, which is every
 * Document the integrity checker accepts; they could in principle disagree for one that does
 * not, and `buildDiff` runs no grammar check on the IRs it is handed.
 */
export const DEPENDENCY_IDENTITY_FIELDS = ["from", "to", "via"] as const

export function dependencyIdentity(parts: readonly string[]): string {
  return parts.join("::")
}

function dependencyKey(d: Dependency): string {
  return dependencyIdentity(DEPENDENCY_IDENTITY_FIELDS.map((field) => d[field]))
}

function compareDependencies(a: Dependency, b: Dependency): number {
  const keyA = dependencyKey(a)
  const keyB = dependencyKey(b)
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sortById<T extends { id: string }>(items: T[]): void {
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
