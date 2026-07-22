/**
 * HTTP method names that Express router / app receivers accept as route handlers.
 * Kept in lower-case to match `member_expression` property text verbatim.
 */
export const EXPRESS_ROUTE_METHODS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
])

export function isRouteMethod(leaf: string): boolean {
  return EXPRESS_ROUTE_METHODS.has(leaf)
}
