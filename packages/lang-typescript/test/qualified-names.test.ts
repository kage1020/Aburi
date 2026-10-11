import { describe, expect, it } from "vitest"
import { symbolOf } from "./fixtures/ctx"

describe("the qualified name a declaration is given", () => {
  it.each([
    ["a method, after a `.`", "export class S { create() {} }", "S.create", "method"],
    [
      "a static method, after a `::`",
      "export class S { static fromJson() {} }",
      "S::fromJson",
      "method",
    ],
    ["an anonymous default export", "export default function () {}", "<default>", "function"],
    ["a const holding an arrow", "export const handler = () => 1", "handler", "function"],
    [
      "a function in nested namespaces",
      "export namespace Billing { export namespace Invoice { export function create() {} } }",
      "Billing.Invoice.create",
      "function",
    ],
  ])("names %s", async (_label, source, name, kind) => {
    const symbol = await symbolOf(source, `ts:src/a.ts#${name}`)

    expect([symbol.name, symbol.kind]).toEqual([name, kind])
  })
})
