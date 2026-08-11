import { describe, expect, it } from "vitest"
import { splitAliasedImportName } from "../src/import-edge"

/**
 * `ImportEdge.symbols` carries one entry per named import, verbatim as the source wrote it.
 * Two consumers recover the halves — the call-graph resolver, to find the exported name a
 * call site's binding points at, and the framework plugins, to find the name a decorator
 * was imported under.
 */
describe("splitAliasedImportName", () => {
  it("splits a renamed import into its exported and local halves", () => {
    expect(splitAliasedImportName("Controller as Ctrl")).toEqual({
      imported: "Controller",
      local: "Ctrl",
    })
  })

  it("reports an unaliased import under the same name twice", () => {
    expect(splitAliasedImportName("Controller")).toEqual({
      imported: "Controller",
      local: "Controller",
    })
  })

  it("trims the entry on both sides of the separator", () => {
    expect(splitAliasedImportName("  Controller  as  Ctrl ")).toEqual({
      imported: "Controller",
      local: "Ctrl",
    })
  })

  it("handles a binding named `as`, which TypeScript accepts as `import { as as as }`", () => {
    expect(splitAliasedImportName("as as as")).toEqual({ imported: "as", local: "as" })
  })

  it("splits on the first separator", () => {
    // No TypeScript source produces two separators — an identifier cannot contain a space —
    // so this pins the rule the function documents rather than a shape it will meet. It is
    // worth pinning because "first" and "last" agree on every real entry, which is exactly
    // the condition under which a reader stops checking.
    expect(splitAliasedImportName("a as b as c")).toEqual({ imported: "a", local: "b as c" })
  })

  it("treats a bare name that merely contains 'as' as unaliased", () => {
    expect(splitAliasedImportName("classify")).toEqual({
      imported: "classify",
      local: "classify",
    })
  })
})
