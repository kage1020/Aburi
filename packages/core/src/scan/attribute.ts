import type { Component, ComponentId } from "@aburi/types"

/**
 * Which Component a file belongs to, answered from `Component.roots[]` alone.
 *
 * Attribution is a prefix question: a Component's root names a directory, and every file
 * beneath it is the Component's until a deeper root claims it. Nesting is ordinary rather
 * than exceptional — a pnpm workspace whose root is a package of its own has `roots: ["."]`
 * containing every other component's root (component-detect.md §3.1.1), so the rule has to
 * be *longest* prefix wins rather than "the first root that matches".
 *
 * Built once per scan and asked once per file, so the answer for a file is a walk up its own
 * directory chain against a Map rather than a scan over every root.
 */
export interface ComponentAttribution {
  /**
   * The id of the Component owning `file`, or `null` when the file sits under no root at all
   * — the `Symbol.component` value ir-schema.md §1.1 defines as "outside every Component".
   *
   * `file` is a workspace-relative POSIX path (ir-schema.md §14 #10), which is what every
   * `SourceFile.path` and `symbols[].source.file` already is.
   */
  attribute(file: string): ComponentId | null
}

/**
 * Index the Components' roots for `attribute`.
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
      const key = normalizeRoot(root)
      const claimed = byRoot.get(key)
      if (claimed === undefined || component.id < claimed) byRoot.set(key, component.id)
    }
  }
  return { attribute: (file) => attributeFile(byRoot, file) }
}

/**
 * The workspace root, spelled the one way ir-schema.md §14 #10 allows: the bare `.`. It is
 * the last key `attributeFile` probes, because a root that names it is a prefix of every
 * path in the Document and so is the shallowest possible match.
 */
const WORKSPACE_ROOT = "."

/**
 * A root as the index keys it: NFC, no leading `./`, no trailing `/`, and `.` for the
 * workspace root however it was written.
 *
 * `toRelativePosix` (workspace.ts) already produces that shape for a detected root, and the
 * CLI holds a configured one to the same rule — but `ScanInput.components` is a public
 * boundary, and a root arriving through it as `./src/` would otherwise index under a key no
 * file path can ever equal, silently attributing the whole component to nothing.
 */
function normalizeRoot(root: string): string {
  const trimmed = root.normalize("NFC").replace(/^\.\//, "").replace(/\/+$/, "")
  return trimmed.length === 0 ? WORKSPACE_ROOT : trimmed
}

/**
 * Walk `file`'s own path from the deepest prefix towards the workspace root, and answer with
 * the first root the index holds. Descending is what makes the match the *longest* one
 * without sorting or comparing lengths.
 *
 * The full path is probed before any of its directories, so a root that names a file — which
 * `components[].roots` does not forbid — claims exactly that file. Every other probe is a
 * directory prefix, and it is compared against whole segments rather than characters:
 * `packages/app-legacy/x.ts` starts with `packages/app` as a string and belongs to no
 * component of that name.
 *
 * The path is normalized to NFC here rather than assumed: a root read from a config and a
 * path read from the filesystem are two strings from two sources, and on a filesystem that
 * stores decomposed names one side would spell `café` the other way and the component would
 * lose its own files.
 */
function attributeFile(byRoot: ReadonlyMap<string, ComponentId>, file: string): ComponentId | null {
  if (byRoot.size === 0) return null
  const normalized = file.normalize("NFC")
  const segments = normalized.split("/")
  for (let end = segments.length; end > 0; end--) {
    const candidate = segments.slice(0, end).join("/")
    const owner = byRoot.get(candidate)
    if (owner !== undefined) return owner
  }
  return byRoot.get(WORKSPACE_ROOT) ?? null
}
