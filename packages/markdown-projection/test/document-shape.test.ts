import {
  call,
  changed,
  component,
  dependency,
  effect,
  makeDiff,
  makeIR,
  makeSymbol,
  rule,
} from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { projectComponent, projectDiff, projectSymbolExplain, projectWorkspace } from "../src"
import { LONG_CONDITION, namedSymbol } from "./fixtures"

const symbol = makeSymbol({
  id: "ts:apps/billing/a.ts#handle",
  name: "handle",
  component: "billing",
  rules: [rule({ type: "guard", condition: LONG_CONDITION, line: 3 })],
  effects: [effect({ id: "db.write", target: "prisma.x.create", plugin: "effects-prisma" })],
  calls: [call({ target: "svc.save", line: 4 })],
})
const billing = component({ id: "billing", name: "Billing", publicApi: ["src/index.ts"] })
const dependencies = [
  dependency({ from: "billing", to: "payments" }),
  dependency({ from: "ts:apps/billing/a.ts#handle", to: "ts:src/b.ts#b", via: "call" }),
]

describe("every view's bytes", () => {
  it.each<[string, string]>([
    [
      "workspace.md",
      projectWorkspace(makeIR({ components: [billing], symbols: [symbol], dependencies })),
    ],
    ["a component page", projectComponent({ component: billing, symbols: [symbol], dependencies })],
    [
      "diff.md",
      projectDiff(
        makeDiff({
          symbols: [{ status: "added", symbol }, changed(namedSymbol("f"), { logicChanged: true })],
          dependencies: { added: dependencies, removed: [] },
          notCompared: [{ path: "vendor/a.ts", baseReason: "over-size", headReason: "over-size" }],
        }),
      ),
    ],
    ["an explain page", projectSymbolExplain(symbol, { dependencies, unresolvedCalls: [] })],
  ])("end %s in a single newline, with no run of blank lines", (_, md) => {
    expect(md).toMatch(/[^\n]\n$/)
    expect(md).not.toMatch(/\n\n\n/)
    expect(md).not.toContain("\r")
  })
})
