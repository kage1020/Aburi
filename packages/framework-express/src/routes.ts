/** Route-registering method names, lower-case to match `member_expression` property text verbatim. */
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
