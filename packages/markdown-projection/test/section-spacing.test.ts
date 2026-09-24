/**
 * MP14 — a list section in a Symbol block ends at a blank line (markdown-projection.md §5.2).
 *
 * CommonMark lets a paragraph line continue the paragraph of the list item above it, so a
 * `**Effects**:` label written straight after a `- guard: …` row renders inside that bullet.
 * After a fenced rule row it does not — a paragraph cannot continue a fence — so without the
 * blank line the same label landed in or out of the list by the length of a condition.
 */

import { call, component, effect, fp, makeSymbol, rule, zeroFp } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { projectComponent, renderSymbolBlock } from "../src"

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

  it("leaves a component file with no run of three newlines", () => {
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [
        handle({
          rules: [rule({ type: "guard", condition: LONG_CONDITION, line: 3 })],
          effects: [EFFECT],
          calls: [CALL],
        }),
      ],
      dependencies: [],
    })
    expect(md).toContain("```\n\n**Effects**:\n")
    expect(md).not.toMatch(/\n{3,}/)
  })
})
