/**
 * Every App Router role this plugin recognizes. Literal union so a typo in a role name
 * is a compile-time error rather than a silent classification miss.
 */
export type AppRouterRole =
  | "page"
  | "layout"
  | "template"
  | "loading"
  | "error"
  | "not-found"
  | "route"

/**
 * Next.js App Router special file names, mapped from their base filename to the
 * `framework:next:*` role they play. Files inside `app/` whose base name matches one of
 * these become framework-classified Symbols; everything else in the same directory
 * (client-side helpers, fixtures, tests, colocated components) does not.
 *
 * The full list is the App Router's stable public surface — Next.js reserves these names
 * for framework use, so recognizing them by name is not a heuristic.
 */
export const NEXT_APP_ROUTER_ROLES: ReadonlyMap<string, AppRouterRole> = new Map([
  ["page", "page"],
  ["layout", "layout"],
  ["template", "template"],
  ["loading", "loading"],
  ["error", "error"],
  ["not-found", "not-found"],
  ["route", "route"],
])

/** Extensions the App Router accepts for its special files. */
const NEXT_APP_ROUTER_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx"])

export interface AppRouterFile {
  /**
   * The role name the file plays in the App Router. `route` files export named HTTP verb
   * handlers; the rest export a default React component.
   */
  role: AppRouterRole
  /**
   * True when the recognized file is `route.{ts,js}` — the plugin treats route handlers
   * differently (named HTTP verb exports, boundary flag) from component-role files (a
   * default export function).
   */
  isRoute: boolean
}

/**
 * Decide whether a Symbol's source file is one of the App Router special files.
 *
 * The path must:
 *   - be POSIX-style (matches `Symbol.source.file` which the core Symbol ID contract
 *     forbids from carrying backslashes)
 *   - contain an `app/` segment somewhere in its parent chain
 *   - end with `<role>.<ext>` where `<role>` is in `NEXT_APP_ROUTER_ROLES` and `<ext>` is
 *     in `NEXT_APP_ROUTER_EXTENSIONS`
 *   - have the recognized special-file segment sit at or below the `app/` segment (so
 *     `apps/foo/page.tsx` outside of any `app/` directory does not accidentally match)
 *
 * The recognition is filename-based rather than framework-config-based because the App
 * Router itself keys off the filename; matching Next.js's own contract keeps this plugin
 * consistent with what the runtime will actually treat as special.
 */
export function recognizeAppRouterFile(path: string): AppRouterFile | null {
  const segments = path.split("/")
  const lastSegment = segments.at(-1)
  if (lastSegment === undefined) return null

  const dot = lastSegment.lastIndexOf(".")
  if (dot < 0) return null
  const ext = lastSegment.slice(dot).toLowerCase()
  if (!NEXT_APP_ROUTER_EXTENSIONS.has(ext)) return null
  const base = lastSegment.slice(0, dot)

  const role = NEXT_APP_ROUTER_ROLES.get(base)
  if (role === undefined) return null

  // The recognized file must sit under an `app/` directory somewhere in its parent chain.
  // Checking `segments.slice(0, -1)` skips the filename itself; the App Router allows
  // arbitrary nesting between `app/` and the final page/layout/route file.
  const parents = segments.slice(0, -1)
  if (!parents.includes("app")) return null

  return { role, isRoute: role === "route" }
}
