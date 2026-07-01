import { describe, expect, it } from "vitest"
import { CoreError, lastQnameSegment } from "../../src/index"

describe("lastQnameSegment", () => {
  it("returns the identifier verbatim when no separator is present", () => {
    expect(lastQnameSegment("createInvoice")).toBe("createInvoice")
  })

  it("returns the tail after '.' for instance members", () => {
    expect(lastQnameSegment("InvoiceService.createInvoice")).toBe("createInvoice")
  })

  it("returns the tail after '::' for static members", () => {
    expect(lastQnameSegment("Class::staticMethod")).toBe("staticMethod")
  })

  it("prefers '::' over '.' when both are present", () => {
    // Static receiver dominates: Class::foo.bar means "field bar on the value returned by
    // static Class::foo", and the fingerprint's shortName tracks the leaf of the receiver.
    expect(lastQnameSegment("A.B::method")).toBe("method")
  })

  it("keeps the <default> sentinel intact", () => {
    expect(lastQnameSegment("<default>")).toBe("<default>")
  })

  it("returns the last segment of deeply nested paths", () => {
    expect(lastQnameSegment("A.B.C.method")).toBe("method")
  })

  it("throws on an empty qualified name (upstream Symbol id builder bug)", () => {
    expect(() => lastQnameSegment("")).toThrowError(CoreError)
  })

  it.each([
    ["trailing '::'", "foo::"],
    ["trailing '.'", "A."],
    ["only '::'", "::"],
    ["only '.'", "."],
  ])("throws on a qname with an empty last segment (%s)", (_, qname) => {
    let caught: unknown
    try {
      lastQnameSegment(qname)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CoreError)
    expect((caught as CoreError).code).toBe("anonymous-symbol-id-attempted")
    expect((caught as CoreError).value).toBe(qname)
  })
})
