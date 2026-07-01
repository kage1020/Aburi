import { describe, expect, it } from "vitest"
import { lastQnameSegment } from "../../src/index"

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
})
