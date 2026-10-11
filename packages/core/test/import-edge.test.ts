import { describe, expect, it } from "vitest"
import { splitAliasedImportName } from "../src/import-edge"

describe("splitAliasedImportName", () => {
  it.each([
    ["a renamed import", "Controller as Ctrl", "Controller", "Ctrl"],
    ["an unaliased import, under its own name twice", "Controller", "Controller", "Controller"],
    ["a name that merely contains `as`", "classify", "classify", "classify"],
    ["a binding named `as` (`import { as as as }`)", "as as as", "as", "as"],
    ["an entry on its first separator", "a as b as c", "a", "b as c"],
    ["an aliased entry, trimming both halves", "  Controller  as  Ctrl ", "Controller", "Ctrl"],
    ["a bare entry, trimmed", "  Controller  ", "Controller", "Controller"],
    ["an empty local half, without repairing it", "Controller as ", "Controller", ""],
    ["an empty exported half, without repairing it", " as Ctrl", "", "Ctrl"],
    ["an empty entry", "", "", ""],
  ])("splits %s", (_entry, raw, imported, local) => {
    expect(splitAliasedImportName(raw)).toEqual({ imported, local })
  })
})
