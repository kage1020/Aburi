import { describe, expect, it } from "vitest"
import {
  assignSymbolFilenames,
  collisionSuffix,
  sanitizeSymbolId,
  withCollisionSuffix,
} from "../src"

describe("sanitizeSymbolId", () => {
  it.each([
    [
      "replaces each separator with `-`",
      "ts:apps/billing/src/InvoiceService.ts#InvoiceService.createInvoice",
      "ts-apps-billing-src-InvoiceService-ts-InvoiceService-createInvoice",
    ],
    ["collapses a run of separators to one dash", "a::b//c", "a-b-c"],
    ["trims leading and trailing dashes", ":a:", "a"],
  ])("%s", (_, id, sanitized) => {
    expect(sanitizeSymbolId(id)).toBe(sanitized)
  })
})

describe("collisionSuffix", () => {
  it("is six hex characters, the same for the same id", () => {
    const suffix = collisionSuffix("ts:src/a.ts#Foo")
    expect(suffix).toMatch(/^[0-9a-f]{6}$/)
    expect(collisionSuffix("ts:src/a.ts#Foo")).toBe(suffix)
    expect(collisionSuffix("ts:src/a.ts#Bar")).not.toBe(suffix)
  })
})

describe("withCollisionSuffix", () => {
  it("always appends the suffix to the sanitized id", () => {
    expect(withCollisionSuffix("ts:src/a.ts#Foo")).toBe(
      `ts-src-a-ts-Foo-${collisionSuffix("ts:src/a.ts#Foo")}`,
    )
  })
})

describe("assignSymbolFilenames", () => {
  it("keeps the sanitized id when no other id shares it", () => {
    const map = assignSymbolFilenames(["ts:src/a.ts#Foo", "ts:src/b.ts#Bar"])
    expect(map.get("ts:src/a.ts#Foo")).toBe("ts-src-a-ts-Foo")
    expect(map.get("ts:src/b.ts#Bar")).toBe("ts-src-b-ts-Bar")
  })

  it("suffixes every id that shares a sanitized form", () => {
    const map = assignSymbolFilenames(["a:b", "a.b", "c"])
    expect(map.get("a:b")).toBe(withCollisionSuffix("a:b"))
    expect(map.get("a.b")).toBe(withCollisionSuffix("a.b"))
    expect(map.get("a:b")).not.toBe(map.get("a.b"))
    expect(map.get("c")).toBe("c")
  })

  it("refuses a Symbol id given twice", () => {
    expect(() => assignSymbolFilenames(["ts:src/a.ts#Foo", "ts:src/a.ts#Foo"])).toThrow(
      /duplicate Symbol id/,
    )
  })
})
