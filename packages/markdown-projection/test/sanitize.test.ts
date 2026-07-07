import { describe, expect, it } from "vitest"
import {
  assignSymbolFilenames,
  collisionSuffix,
  sanitizeSymbolId,
  withCollisionSuffix,
} from "../src"

describe("sanitizeSymbolId (§8)", () => {
  it("replaces separators with `-` and collapses runs", () => {
    expect(
      sanitizeSymbolId("ts:apps/billing/src/InvoiceService.ts#InvoiceService.createInvoice"),
    ).toBe("ts-apps-billing-src-InvoiceService-ts-InvoiceService-createInvoice")
  })

  it("collapses consecutive dashes to one", () => {
    expect(sanitizeSymbolId("a::b//c")).toBe("a-b-c")
  })

  it("trims leading/trailing dashes", () => {
    expect(sanitizeSymbolId(":a:")).toBe("a")
  })
})

describe("collisionSuffix (§8 tail)", () => {
  it("is deterministic and 6 hex chars", () => {
    const suffix = collisionSuffix("ts:src/a.ts#Foo")
    expect(suffix).toMatch(/^[0-9a-f]{6}$/)
    expect(collisionSuffix("ts:src/a.ts#Foo")).toBe(suffix)
  })

  it("differs for different inputs", () => {
    expect(collisionSuffix("a")).not.toBe(collisionSuffix("b"))
  })
})

describe("withCollisionSuffix", () => {
  it("always appends the deterministic suffix", () => {
    const value = withCollisionSuffix("ts:src/a.ts#Foo")
    expect(value).toMatch(/^ts-src-a-ts-Foo-[0-9a-f]{6}$/)
  })
})

describe("assignSymbolFilenames — collision handling", () => {
  it("keeps the base name when there is no collision", () => {
    const map = assignSymbolFilenames(["ts:src/a.ts#Foo", "ts:src/b.ts#Bar"])
    expect(map.get("ts:src/a.ts#Foo")).toBe("ts-src-a-ts-Foo")
    expect(map.get("ts:src/b.ts#Bar")).toBe("ts-src-b-ts-Bar")
  })

  it("MP9: adds a hash suffix when two ids sanitise to the same base", () => {
    // Both ids sanitise to "a-b" so both entries must switch to the -<hash> form.
    const map = assignSymbolFilenames(["a:b", "a.b"])
    const a = map.get("a:b")
    const b = map.get("a.b")
    expect(a).toMatch(/^a-b-[0-9a-f]{6}$/)
    expect(b).toMatch(/^a-b-[0-9a-f]{6}$/)
    expect(a).not.toBe(b)
  })

  it("throws on a duplicate Symbol id (IR contract forbids duplicates)", () => {
    expect(() => assignSymbolFilenames(["ts:src/a.ts#Foo", "ts:src/a.ts#Foo"])).toThrow(
      /duplicate Symbol id/,
    )
  })
})
