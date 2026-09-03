import type { Component, ComponentId } from "@aburi/types"

/**
 * Which Component a file belongs to, answered from `Component.roots[]` alone: the id of the
 * Component owning `file`, or `null` when the file sits under no root at all — the
 * `Symbol.component` value ir-schema.md §1.1 defines as "outside every Component".
 *
 * Attribution is a prefix question: a Component's root names a path — ordinarily a
 * directory, though a root that names a single file is not forbidden — and every file
 * beneath it is the Component's until a deeper root claims it. Nesting is ordinary rather
 * than exceptional: a pnpm workspace whose root is a package of its own has `roots: ["."]`
 * containing every other component's root (component-detect.md §3.1.1), so the rule has to
 * be *longest* prefix wins rather than "the first root that matches".
 *
 * `file` is a workspace-relative POSIX path, and one that ascends out of the workspace or
 * names nothing at all is attributed `null` rather than falling through to a root component
 * — `scan()` only ever asks about a path `toDocumentPath` has already accepted, but this is
 * public API and its callers have made no such promise.
 *
 * A function rather than an object with one method: there is one implementation and no
 * injection point, so an interface would only add a second exported name and a writable
 * method slot.
 */
export type ComponentAttribution = (file: string) => ComponentId | null

/**
 * Index the Components' roots for the returned attribution function.
 *
 * Two Components may name the same root — nothing in the schema forbids it, and a config
 * that declares one Component per framework over a shared directory produces it — so the
 * index keeps the lower id of the two. Lowest rather than first because `Component.id` is
 * unique (integrity invariant #2) and its order is the one the IR is already sorted in,
 * whereas "first" would make a Symbol's attribution depend on the order the config happened
 * to list its components in.
 *
 * An empty `components` (the shape `ScanInput` allows a caller that has not detected any)
 * attributes every file to `null`, which is the same answer this code gave before it
 * existed.
 */
export function buildComponentAttribution(components: readonly Component[]): ComponentAttribution {
  const byRoot = new Map<string, ComponentId>()
  for (const component of components) {
    for (const root of component.roots) {
      const key = rootKey(root)
      if (key === null) continue
      const claimed = byRoot.get(key)
      if (claimed === undefined || component.id < claimed) byRoot.set(key, component.id)
    }
  }
  return (file) => attributeFile(byRoot, file)
}

/**
 * The workspace root's key. Empty because a key is a `/`-joined list of non-empty segments,
 * so nothing else can produce it — and because the root is the shallowest possible match, it
 * is the last thing `attributeFile` probes.
 */
const WORKSPACE_ROOT_KEY = ""

/**
 * A path as the index keys it: NFC, split on `/`, with the segments that name nothing —
 * empty ones and `.` — dropped, then rejoined.
 *
 * Both sides of the comparison go through this, which is the point. `toRelativePosix`
 * (workspace.ts) already produces that shape for a detected root and the CLI holds a
 * configured one to the same rule, but `ScanInput.components` and `buildComponentAttribution`
 * are both public boundaries, and the two sides arrive from different places: a root from a
 * config, a path from a filesystem walk. Normalizing one and not the other is how
 * `./apps/web/x.ts` misses the root `apps/web` and lands on the workspace component instead
 * — a wrong answer rather than a missing one, and one integrity invariant #3 cannot see,
 * because the id it names was properly declared.
 *
 * The dropped segments are the ones no rule upstream removes. `posixWorkspaceRelativeViolation`
 * (id.ts) refuses a `.` segment and an empty *path*, but `packages//api` holds an empty
 * *segment* and passes it, as it passes integrity #10 — so without this the component at that
 * root would quietly hold no Symbols at all.
 *
 * NFC because a root read from a config and a path read from the filesystem are two strings
 * from two sources: on a filesystem that stores decomposed names, one side would spell `café`
 * the other way and the component would lose its own files (ir-schema.md §14 #19, §1.2).
 */
function pathSegments(path: string): string[] {
  return path
    .normalize("NFC")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
}

/**
 * The index key for one `Component.roots[]` entry, or `null` for a root that names nothing
 * this Document can hold.
 *
 * `.` and `./` are the workspace root and key as such. `""` and `"/"` are neither that nor a
 * directory — they are a caller's mistake — and they are dropped rather than folded into the
 * workspace root, because folding them there hands the offending component every file in the
 * workspace. `scan()` would catch the mis-attribution at `assertIRIntegrity` only if the id
 * were undeclared, which it is not; a caller driving `runFilePipeline` itself never reaches
 * that check at all. Failing closed costs that component its Symbols and says so in the
 * `0` its row carries, which is the visible failure of the two.
 *
 * A root holding `..` is refused for the same reason a file holding one is: it names
 * something outside the workspace the Document is about.
 */
function rootKey(root: string): string | null {
  const segments = pathSegments(root)
  if (segments.some((segment) => segment === "..")) return null
  if (segments.length > 0) return segments.join("/")
  return root.normalize("NFC").split("/").includes(".") ? WORKSPACE_ROOT_KEY : null
}

/**
 * Walk `file`'s own path from the deepest prefix towards the workspace root, and answer with
 * the first root the index holds. Descending is what makes the match the *longest* one
 * without sorting or comparing lengths.
 *
 * The full path is probed before any of its directories, so a root that names a file claims
 * exactly that file. Every other probe is a directory prefix, and it is compared against
 * whole segments rather than characters: `packages/app-legacy/x.ts` starts with
 * `packages/app` as a string and belongs to no component of that name.
 *
 * A path that ascends out of the workspace, or that holds no segment at all, is attributed
 * `null` and does not reach the workspace-root probe — a file the Document has no way to be
 * about must not be counted towards a Component that is in it.
 */
function attributeFile(byRoot: ReadonlyMap<string, ComponentId>, file: string): ComponentId | null {
  if (byRoot.size === 0) return null
  const segments = pathSegments(file)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === "..")) return null
  for (let end = segments.length; end > 0; end--) {
    const owner = byRoot.get(segments.slice(0, end).join("/"))
    if (owner !== undefined) return owner
  }
  return byRoot.get(WORKSPACE_ROOT_KEY) ?? null
}
