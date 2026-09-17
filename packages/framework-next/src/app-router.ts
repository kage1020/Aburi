export type AppRouterRole =
  | "page"
  | "layout"
  | "template"
  | "loading"
  | "error"
  | "not-found"
  | "route"

/**
 * App Router special file base names → the role they play. Not covered yet: `default`,
 * `global-error`, `middleware`, `instrumentation` and the metadata files (`sitemap`, `icon`,
 * `opengraph-image`, …); adding one is a table extension here, not a classifier change.
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

const NEXT_APP_ROUTER_COMPONENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
])

/** The runtime does not recognize `route.tsx` / `route.jsx`: route files never render JSX. */
const NEXT_APP_ROUTER_ROUTE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".js"])

/** Result of `recognizeAppRouterFile`; callers branch on `role`. */
export type AppRouterFile = { readonly role: AppRouterRole }

/**
 * Whether a Symbol's source file is an App Router special file: a POSIX path (the Symbol ID
 * contract forbids backslashes) with an `app` segment somewhere among its parents, ending
 * in `<role>.<ext>` with `<ext>` accepted for that role. Filename-based because the App
 * Router itself keys off the filename.
 */
export function recognizeAppRouterFile(path: string): AppRouterFile | null {
  const segments = path.split("/")
  const lastSegment = segments.at(-1)
  if (lastSegment === undefined) return null

  const dot = lastSegment.lastIndexOf(".")
  if (dot < 0) return null
  // The base name stays case-sensitive: the runtime treats `Page.tsx` as a colocated component.
  const ext = lastSegment.slice(dot).toLowerCase()
  const base = lastSegment.slice(0, dot)

  const role = NEXT_APP_ROUTER_ROLES.get(base)
  if (role === undefined) return null

  const allowedExtensions =
    role === "route" ? NEXT_APP_ROUTER_ROUTE_EXTENSIONS : NEXT_APP_ROUTER_COMPONENT_EXTENSIONS
  if (!allowedExtensions.has(ext)) return null

  // Any `app` parent counts: monorepos routinely nest it (`apps/web/app/page.tsx`).
  const parents = segments.slice(0, -1)
  if (!parents.includes("app")) return null

  return { role }
}
