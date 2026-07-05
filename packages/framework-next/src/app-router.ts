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
 * Scope note: this is the subset the framework plugin recognizes today. The App Router
 * also uses `default` (Parallel Routes fallback), `global-error`, `middleware`,
 * `instrumentation`, and the metadata files (`sitemap`, `icon`, `opengraph-image`, …)
 * as reserved names. Those are outside the current recognizer's scope; adding them is a
 * table extension in this file, not a classifier change.
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

/**
 * Extensions the App Router accepts for its component-role files
 * (page / layout / template / loading / error / not-found). All React component roles
 * accept .ts / .tsx / .js / .jsx.
 */
const NEXT_APP_ROUTER_COMPONENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
])

/**
 * Extensions the App Router accepts specifically for `route.*`. The runtime does not
 * recognize `route.tsx` / `route.jsx` — route files export named HTTP verb handlers and
 * do not participate in JSX rendering. Keeping the two extension sets separate matches
 * the runtime and prevents the recognizer from misclassifying a `route.tsx` sibling as
 * a route handler.
 */
const NEXT_APP_ROUTER_ROUTE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".js"])

/**
 * Result shape for `recognizeAppRouterFile`. Discriminated on `role` so callers can
 * narrow to the route vs component branch at compile time without a redundant
 * `isRoute` boolean.
 */
export type AppRouterFile =
  | { readonly role: "route" }
  | { readonly role: Exclude<AppRouterRole, "route"> }

/**
 * Decide whether a Symbol's source file is one of the App Router special files.
 *
 * The path must:
 *   - be POSIX-style (matches `Symbol.source.file` which the core Symbol ID contract
 *     forbids from carrying backslashes)
 *   - contain an `app/` segment somewhere in its parent chain
 *   - end with `<role>.<ext>` where `<role>` is in `NEXT_APP_ROUTER_ROLES` and `<ext>` is
 *     accepted for that role's extension whitelist (`route` files only accept .ts / .js;
 *     component roles additionally accept .tsx / .jsx)
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
  // Base name is case-sensitive on purpose: the App Router runtime treats `Page.tsx` as
  // a normal colocated component, not a route. Matching the runtime here means comparing
  // the base with a lowercased set below.
  const ext = lastSegment.slice(dot).toLowerCase()
  const base = lastSegment.slice(0, dot)

  const role = NEXT_APP_ROUTER_ROLES.get(base)
  if (role === undefined) return null

  const allowedExtensions =
    role === "route" ? NEXT_APP_ROUTER_ROUTE_EXTENSIONS : NEXT_APP_ROUTER_COMPONENT_EXTENSIONS
  if (!allowedExtensions.has(ext)) return null

  // The recognized file must sit under an `app/` directory somewhere in its parent chain.
  // Checking `segments.slice(0, -1)` skips the filename itself; the App Router allows
  // arbitrary nesting between `app/` and the final page/layout/route file. Any `app`
  // segment counts — the recognizer intentionally does not require `app/` to be the
  // package root because monorepos routinely nest it (e.g. `apps/web/app/page.tsx`).
  const parents = segments.slice(0, -1)
  if (!parents.includes("app")) return null

  return role === "route" ? { role } : { role }
}
