import { serializeCanonical } from "@aburi/core"
import { beforeAll, describe, expect, it } from "vitest"
import { irValidator } from "../src/ir-schema"
import { diffIRs, scanFixture } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A rule's `condition`, `what` and `expr` reach the IR in the form ir-schema.md §8.2 gives
 * them. Written as the source spelled them, a long rule broke the schema's `maxLength: 123`, a
 * re-wrapped guard was listed under "rules modified" beside an unrelated edit, and a comment in
 * a condition moved `logic`, which fingerprint.md says comments do not.
 */

const workspace = useScratchWorkspace("rule-text-form")

let schemaViolations: (document: unknown) => string[]

beforeAll(async () => {
  schemaViolations = await irValidator()
})

describe("e2e scan — a long rule fits the schema", () => {
  it("writes the IR the frozen schema accepts", async () => {
    await workspace.writeSource(
      "src/price.ts",
      [
        "interface Order { total: number; discounts: number; customer: { creditLimit: number; outstandingBalance: number } }",
        "",
        "export function price(order: Order): number {",
        "  if (order.customer.creditLimit - order.customer.outstandingBalance < order.total - order.discounts && order.total > 1000000 && order.discounts > 0) {",
        '    throw new Error("over the credit limit")',
        "  }",
        "  if (",
        "    order.total > 0 &&",
        "    order.discounts > 0",
        "  ) {",
        "    return 1",
        "  }",
        "  return order.customer.creditLimit - order.customer.outstandingBalance + order.total * 2 - order.discounts / 3 + order.total * order.discounts",
        "}",
        "",
      ].join("\n"),
    )
    const { ir } = await scanFixture(workspace.root)

    expect(schemaViolations(JSON.parse(serializeCanonical(ir)))).toEqual([])
    const price = ir.symbols.find((s) => s.name === "price")
    const guard =
      "order.customer.creditLimit - order.customer.outstandingBalance < order.total - order.discounts && order.total > 1000000 && order.discounts > 0"
    const sum =
      "order.customer.creditLimit - order.customer.outstandingBalance + order.total * 2 - order.discounts / 3 + order.total * order.discounts"
    expect(price?.rules.map((r) => [r.type, r.condition ?? r.what ?? r.expr])).toEqual([
      ["guard", `${guard.slice(0, 120)}...`],
      ["throw", "Error"],
      ["guard", "order.total > 0 && order.discounts > 0"],
      ["return", `${sum.slice(0, 120)}...`],
    ])
  })
})

describe("e2e diff — a re-wrapped guard is the same guard", () => {
  it("lists only the guard that was added", async () => {
    await workspace.writeSource(
      "src/check.ts",
      [
        "export function check(user: { age: number; banned: boolean; role: string }) {",
        '  if (user.age < 18 || user.banned || user.role === "guest") {',
        '    throw new Error("denied")',
        "  }",
        "  return user.role",
        "}",
        "",
      ].join("\n"),
    )
    const baseIR = (await scanFixture(workspace.root)).ir
    await workspace.writeSource(
      "src/check.ts",
      [
        "export function check(user: { age: number; banned: boolean; role: string }) {",
        "  if (",
        "    user.age < 18 ||",
        "    user.banned ||",
        '    user.role === "guest"',
        "  ) {",
        '    throw new Error("denied")',
        "  }",
        '  if (user.role === "root") return "admin"',
        "  return user.role",
        "}",
        "",
      ].join("\n"),
    )
    const headIR = (await scanFixture(workspace.root)).ir
    const [entry] = diffIRs(baseIR, headIR).symbols.filter((c) => c.status === "changed")

    expect(entry?.status === "changed" ? entry.delta.rules : undefined).toMatchObject({
      added: [{ type: "guard", condition: 'user.role === "root"' }],
      removed: [],
      modified: [],
    })
  })
})

describe("e2e diff — a comment is not a logic change", () => {
  it("leaves a Symbol whose only edit is comments unchanged", async () => {
    const price = (guardNote: string, returnNote: string) =>
      [
        "export function price(qty: number, unit: number, member: boolean): number {",
        `  if (qty <= 0 ${guardNote}|| unit < 0) {`,
        '    throw new RangeError("bad input")',
        "  }",
        `  return member ? qty * unit * 0.9 ${returnNote}: qty * unit`,
        "}",
        "",
      ].join("\n")
    await workspace.writeSource("src/price.ts", price("", ""))
    const baseIR = (await scanFixture(workspace.root)).ir
    await workspace.writeSource(
      "src/price.ts",
      price("/* nothing to charge */ ", "/* member discount */ "),
    )
    const headIR = (await scanFixture(workspace.root)).ir
    const diff = diffIRs(baseIR, headIR)

    expect(diff.summary.changed).toBe(0)
    expect(headIR.symbols.find((s) => s.name === "price")?.fingerprint).toEqual(
      baseIR.symbols.find((s) => s.name === "price")?.fingerprint,
    )
  })
})
