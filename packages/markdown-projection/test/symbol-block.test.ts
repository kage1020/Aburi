import {
  call,
  component,
  decorator,
  effect,
  fp,
  makeSymbol,
  rule,
  sig,
  zeroFp,
} from "@aburi/test-support"
import type { Decorator } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectComponent, renderSymbolBlock } from "../src"
import { LONG_CONDITION, projectChanges } from "./fixtures"

function handle(overrides: Omit<Parameters<typeof makeSymbol>[0], "id" | "name">) {
  return makeSymbol({ ...overrides, id: "ts:src/a.ts#handle", name: "handle" })
}

const EFFECT = effect({
  id: "db.write",
  target: "prisma.x.create",
  plugin: "effects-prisma",
  line: 7,
})
const CALL = call({ target: "svc.save", line: 20 })

describe("renderSymbolBlock — what a Symbol block holds", () => {
  it("writes every part in order, each list sorted, and a blank line after each list", () => {
    const block = renderSymbolBlock(
      handle({
        decorators: [
          decorator({ name: "Post", raw: "Post('/x')", boundary: true }),
          decorator({ name: "UseGuards", raw: "UseGuards(Auth)" }),
        ],
        signature: sig({ inputs: [{ name: "id", type: "string" }], outputs: ["Promise<User>"] }),
        rules: [
          rule({ type: "throw", what: "new E()", line: 8 }),
          rule({ type: "guard", condition: "x > 0", line: 3 }),
        ],
        effects: [
          effect({ id: "queue.publish", target: "bus.emit", plugin: "effects-nest", line: 9 }),
          effect({
            id: "db.write",
            target: "prisma.x.create",
            plugin: "effects-prisma",
            propagated: true,
            derivedFrom: ["ts:src/z.ts#z"],
          }),
          effect({ id: "db.read", target: "prisma.x.find", plugin: "effects-prisma", line: 4 }),
          effect({
            id: "db.read",
            target: "prisma.a.find",
            plugin: "effects-prisma",
            propagated: true,
            derivedFrom: ["ts:src/y.ts#y", "ts:src/x.ts#x"],
          }),
        ],
        calls: [
          call({ target: "svc.save", line: 20, resolved: "ts:src/svc.ts#save" }),
          call({ target: "log", line: 11 }),
        ],
        fingerprint: fp("v1"),
      }),
    )
    expect(block).toEqual([
      "#### `handle` *(function)*",
      "**Boundary**: `@Post('/x')`",
      "**Decorators**: `@UseGuards(Auth)`",
      "**Signature**: `(id: string) → Promise<User>`",
      "**Rules**:",
      "- guard: `x > 0` (L3)",
      "- throw: `new E()` (L8)",
      "",
      "**Effects**:",
      "- db.read: `prisma.x.find` (L4) [effects-prisma]",
      "- queue.publish: `bus.emit` (L9) [effects-nest]",
      "- db.read: `prisma.a.find` [propagated from ts:src/y.ts#y, ts:src/x.ts#x] [effects-prisma]",
      "- db.write: `prisma.x.create` [propagated from ts:src/z.ts#z] [effects-prisma]",
      "",
      "**Calls**:",
      "- `log` (L11)",
      "- `svc.save` (L20)",
      "",
      "<sub>api=`000000api-v1` logic=`000000log-v1` syntax=`000000syn-v1`</sub>",
    ])
  })

  it("writes only the heading and fingerprint for a Symbol with nothing else", () => {
    expect(renderSymbolBlock(handle({ fingerprint: fp("v1") }))).toEqual([
      "#### `handle` *(function)*",
      "<sub>api=`000000api-v1` logic=`000000log-v1` syntax=`000000syn-v1`</sub>",
    ])
  })

  it("writes no fingerprint line for a zero fingerprint", () => {
    expect(renderSymbolBlock(handle({ fingerprint: zeroFp() }))).toEqual([
      "#### `handle` *(function)*",
    ])
  })

  it.each<[string, Decorator[], string[]]>([
    [
      "boundary",
      [decorator({ name: "Get", boundary: true }), decorator({ name: "Post", boundary: true })],
      ["**Boundary**: `@Get()` `@Post()`"],
    ],
    ["other", [decorator({ name: "Injectable" })], ["**Decorators**: `@Injectable()`"]],
  ])("writes no row for a decorator kind it has none of, given only %s ones", (_, list, rows) => {
    expect(renderSymbolBlock(handle({ decorators: list, fingerprint: zeroFp() }))).toEqual([
      "#### `handle` *(function)*",
      ...rows,
    ])
  })

  it("refuses a propagated effect with no direct source rather than write it sourceless", () => {
    const sourceless = effect({
      id: "db.write",
      target: "prisma.x.create",
      plugin: "effects-prisma",
      propagated: true,
      derivedFrom: [],
    })
    expect(() => renderSymbolBlock(handle({ effects: [sourceless] }))).toThrow(
      /derivedFrom required on propagated Effect/,
    )
  })
})

describe("renderSymbolBlock — blank lines between list sections", () => {
  it("gives a label the same blank line after a fenced rule as after an inline one", () => {
    const withRule = (condition: string) =>
      renderSymbolBlock(
        handle({ rules: [rule({ type: "guard", condition, line: 3 })], effects: [EFFECT] }),
      )
    const inline = withRule("x > 0")
    const fenced = withRule(LONG_CONDITION)
    expect(fenced).toContain("- guard (L3):")
    for (const block of [inline, fenced]) {
      expect(block[block.indexOf("**Effects**:") - 1]).toBe("")
    }
  })

  it("adds no blank line before a list or after the last section", () => {
    const block = renderSymbolBlock(handle({ calls: [CALL], fingerprint: zeroFp() }))
    expect(block[block.indexOf("**Calls**:") + 1]).toBe("- `svc.save` (L20)")
    expect(block.at(-1)).toBe("- `svc.save` (L20)")
  })

  it("never emits two blank lines in a row", () => {
    const block = renderSymbolBlock(
      handle({
        rules: [rule({ type: "guard", condition: LONG_CONDITION, line: 3 })],
        effects: [EFFECT],
        calls: [CALL],
        fingerprint: fp("v1"),
      }),
    )
    expect(block.filter((row, i) => row === "" && block[i + 1] === "")).toEqual([])
  })

  it("ends a fenced rule's list in a component file", () => {
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [
        handle({
          rules: [rule({ type: "guard", condition: LONG_CONDITION, line: 3 })],
          effects: [EFFECT],
        }),
      ],
      dependencies: [],
    })
    expect(md).toContain("```\n\n**Effects**:\n")
  })

  it("separates the sections of an Added symbol in diff.md", () => {
    const symbol = handle({
      rules: [rule({ type: "guard", condition: "x > 0", line: 3 })],
      effects: [EFFECT],
      fingerprint: fp("v1"),
    })
    const md = projectChanges([{ status: "added", symbol }])
    expect(md).toContain("- guard: `x > 0` (L3)\n\n**Effects**:\n")
    expect(md).toMatch(/\(L7\) \[effects-prisma\]\n\n<sub>api=/)
  })
})
