import { decorator, effect, rule, sig } from "@aburi/test-support"
import type { Symbol as IRSymbol, Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeLanguageId } from "../../src/id"
import { apiFingerprint } from "../../src/index"
import { makeSymbol, type SymbolOverrides } from "../fixtures/ir"

const SIGNATURE = sig({
  inputs: [{ name: "dto", type: "CreateInvoiceDto" }],
  outputs: ["Promise<Invoice>"],
  throws: ["CreditLimitExceeded"],
  async: true,
})

const POST = decorator({
  name: "Post",
  raw: "Post('/invoices')",
  arguments: ["'/invoices'"],
  boundary: true,
  line: 12,
})
const GUARDS = decorator({
  name: "UseGuards",
  raw: "UseGuards(RolesGuard)",
  arguments: ["RolesGuard"],
  line: 13,
})
const OK = decorator({ name: "ApiResponse", raw: "ApiResponse(200)", line: 10 })
const NOT_FOUND = decorator({ name: "ApiResponse", raw: "ApiResponse(404)", line: 11 })

function method(overrides: SymbolOverrides = {}): IRSymbol {
  return makeSymbol("ts:src/a.ts#InvoiceService.createInvoice", {
    kind: "method",
    signature: SIGNATURE,
    ...overrides,
  })
}

function withSignature(overrides: Partial<Signature>): IRSymbol {
  return method({ signature: { ...SIGNATURE, ...overrides } })
}

describe("apiFingerprint ignores", () => {
  it.each<[string, IRSymbol, IRSymbol]>([
    [
      "a parameter's name",
      withSignature({ inputs: [{ name: "input", type: "CreateInvoiceDto" }] }),
      method(),
    ],
    [
      "a `...` spelled into a parameter's name",
      withSignature({ inputs: [{ name: "...ids", type: "string[]" }] }),
      withSignature({ inputs: [{ name: "ids", type: "string[]" }] }),
    ],
    [
      "a reflowed type",
      withSignature({ outputs: ["Map<string,\n    Invoice>"] }),
      withSignature({ outputs: ["Map<string, Invoice>"] }),
    ],
    [
      "the order of the throws list",
      withSignature({ throws: ["A", "B"] }),
      withSignature({ throws: ["B", "A"] }),
    ],
    [
      "rules, effects and calls",
      method({
        rules: [rule({ type: "guard", line: 5, condition: "x > 0" })],
        effects: [
          effect({ id: "db.write", target: "prisma.invoice.create", plugin: "p", line: 7 }),
        ],
        calls: [{ target: "helper", line: 8, resolved: null }],
      }),
      method(),
    ],
    [
      "the order decorators are declared in",
      method({ decorators: [POST, GUARDS] }),
      method({ decorators: [GUARDS, POST] }),
    ],
    [
      "the order of same-name decorators, which are kept in line order",
      method({ decorators: [OK, NOT_FOUND] }),
      method({ decorators: [NOT_FOUND, OK] }),
    ],
    [
      "the class the member sits in",
      method({ name: "Old.createInvoice" }),
      method({ name: "New.createInvoice" }),
    ],
    ["the language", method({ language: makeLanguageId("tsx") }), method()],
  ])("%s", (_what, a, b) => {
    expect(apiFingerprint(a)).toBe(apiFingerprint(b))
  })
})

describe("apiFingerprint moves with", () => {
  it.each<[string, IRSymbol, IRSymbol]>([
    ["visibility", method({ visibility: "private" }), method()],
    ["kind", method({ kind: "function" }), method()],
    ["extKind", method({ extKind: "framework:nestjs:controller" }), method()],
    ["the member's own name", method({ name: "InvoiceService.updateInvoice" }), method()],
    ["an added output", withSignature({ outputs: ["Promise<Invoice>", "Metadata"] }), method()],
    [
      "an added throws entry",
      withSignature({ throws: ["CreditLimitExceeded", "AuditFailed"] }),
      method(),
    ],
    ["async", withSignature({ async: false }), method()],
    ["generator", withSignature({ generator: true }), method()],
    ["an added type parameter", withSignature({ typeParameters: ["T"] }), method()],
    [
      "a type parameter's constraint",
      withSignature({ typeParameters: ["T extends string"] }),
      withSignature({ typeParameters: ["T extends number"] }),
    ],
    [
      "a parameter becoming optional",
      withSignature({ inputs: [{ name: "dto", type: "CreateInvoiceDto", optional: true }] }),
      method(),
    ],
    [
      "a parameter becoming rest",
      withSignature({ inputs: [{ name: "dto", type: "CreateInvoiceDto", rest: true }] }),
      method(),
    ],
    [
      "optional against rest, which are two contracts",
      withSignature({ inputs: [{ name: "dto", type: "CreateInvoiceDto", optional: true }] }),
      withSignature({ inputs: [{ name: "dto", type: "CreateInvoiceDto", rest: true }] }),
    ],
    [
      "the order of parameters",
      withSignature({
        inputs: [
          { name: "a", type: "A" },
          { name: "b", type: "B" },
        ],
      }),
      withSignature({
        inputs: [
          { name: "b", type: "B" },
          { name: "a", type: "A" },
        ],
      }),
    ],
    [
      "the order of outputs",
      withSignature({ outputs: ["A", "B"] }),
      withSignature({ outputs: ["B", "A"] }),
    ],
    ["an added decorator", method({ decorators: [POST] }), method()],
    [
      "a decorator's argument",
      method({ decorators: [POST] }),
      method({
        decorators: [{ ...POST, raw: "Post('/customers')", arguments: ["'/customers'"] }],
      }),
    ],
    [
      "a decorator's boundary flag",
      method({ decorators: [POST] }),
      method({ decorators: [{ ...POST, boundary: false }] }),
    ],
    [
      "swapping the lines of two same-name decorators",
      method({ decorators: [OK, NOT_FOUND] }),
      method({
        decorators: [
          { ...NOT_FOUND, line: 10 },
          { ...OK, line: 11 },
        ],
      }),
    ],
  ])("%s", (_what, a, b) => {
    expect(apiFingerprint(a)).not.toBe(apiFingerprint(b))
  })
})
