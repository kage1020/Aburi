/** MP14 — a list section in a Symbol block ends at a blank line (markdown-projection.md §5.2). */

import { call, component, effect, fp, makeSymbol, rule, zeroFp } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { projectComponent, projectDiff, renderSymbolBlock } from "../src"
import { makeDiff } from "./fixtures"

const LONG_CONDITION =
  "user.role === 'admin' && flags.enabled && !session.expired && ctx.tenant === wantedTenantName"

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

describe("MP14 — each list section is followed by a blank line", () => {
  it("separates Rules, Effects, Calls and the fingerprint line", () => {
    const block = renderSymbolBlock(
      handle({
        rules: [rule({ type: "guard", condition: "x > 0", line: 3 })],
        effects: [EFFECT],
        calls: [CALL],
        fingerprint: fp("v1"),
      }),
    )
    const labels = ["**Effects**:", "**Calls**:"]
    for (const label of labels) expect(block[block.indexOf(label) - 1]).toBe("")
    expect(block.at(-2)).toBe("")
    expect(block.at(-1)).toMatch(/^<sub>api=/)
  })

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
    const md = projectDiff(makeDiff({ symbols: [{ status: "added", symbol }] }))
    expect(md).toContain("- guard: `x > 0` (L3)\n\n**Effects**:\n")
    expect(md).toMatch(/\(L7\) \[effects-prisma\]\n\n<sub>api=/)
  })
})
