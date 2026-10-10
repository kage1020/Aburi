import { findReturnedJsxElementName, hasJsxReturn, isProviderElementName } from "./jsx"

/** The gate React itself uses to tell `<Foo />` from an HTML element. */
export function isPascalCase(leaf: string): boolean {
  if (leaf.length === 0) return false
  const first = leaf.charCodeAt(0)
  return first >= 0x41 && first <= 0x5a
}

export function matchesHocNaming(leaf: string): boolean {
  return /^with[A-Z]/.test(leaf)
}

export function returnsContextProvider(body: unknown): boolean {
  return isProviderElementName(findReturnedJsxElementName(body))
}

export function returnsJsx(body: unknown): boolean {
  return hasJsxReturn(body)
}
