import { describe, expect, it } from "vitest"
import { lastQnameSegment } from "../../src/index"

describe("lastQnameSegment", () => {
  it.each([
    ["createInvoice", "createInvoice"],
    ["InvoiceService.createInvoice", "createInvoice"],
    ["A.B.C.method", "method"],
    ["Class::staticMethod", "staticMethod"],
    ["A.B::method", "method"],
    ["C.#v", "#v"],
    ["C::#v", "#v"],
    ["<default>", "<default>"],
  ])("answers %j with %j", (qname, leaf) => {
    expect(lastQnameSegment(qname)).toBe(leaf)
  })

  it.each(["", "foo::", "A.", "::", "."])("refuses %j, whose last segment is empty", (qname) => {
    expect(() => lastQnameSegment(qname)).toThrowError(
      expect.objectContaining({ code: "anonymous-symbol-id-attempted", value: qname }),
    )
  })
})
