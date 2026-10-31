import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { diffOfMove, pairingOutcome } from "./fixtures/scan"

const workspace = useScratchWorkspace("logic-fingerprint-pairing")

describe("diff — pairing a Symbol that moved file on its logic fingerprint", () => {
  it("reports a deleted function whose logic names nothing as removed, not as moved", async () => {
    const diff = await diffOfMove(
      workspace,
      {
        "src/mail.ts":
          "export function sendWelcomeEmail(to: string): void {\n  mailer.send(to)\n}\n",
      },
      {
        "src/invoice.ts": [
          "export class InvoiceRenderer {",
          "  render(total: number): string {",
          "    return total.toFixed(2)",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    )
    expect(pairingOutcome(diff)).toEqual([
      "added InvoiceRenderer",
      "added InvoiceRenderer.render",
      "removed sendWelcomeEmail",
    ])
  })

  it.each([
    [
      "a concise arrow",
      (name: string) => `export const ${name} = (u: { role: string }) => u.role === "admin"\n`,
    ],
    [
      "a block-bodied function",
      (name: string) =>
        `export function ${name}(u: { role: string }) {\n  return u.role === "admin"\n}\n`,
    ],
  ])("pairs %s moved and renamed on its logic fingerprint", async (_label, write) => {
    const diff = await diffOfMove(
      workspace,
      { "src/a.ts": write("isAdminUser") },
      { "src/b.ts": write("canAdministerSite") },
    )
    expect(pairingOutcome(diff)).toEqual([
      "moved+changed isAdminUser -> canAdministerSite (logic-fingerprint)",
    ])
  })
})

describe("diff — two identical helpers deduplicated into one", () => {
  const emptyIR = (name: string) =>
    `export function ${name}(): Document {\n  return { symbols: [], components: [] }\n}\n`

  it("pairs one with the survivor and names the survivor on the other's removal", async () => {
    const diff = await diffOfMove(
      workspace,
      { "src/diff.test.ts": emptyIR("makeEmptyIR"), "src/output.test.ts": emptyIR("emptyIR") },
      { "src/fixtures.ts": emptyIR("emptyIR") },
    )

    expect(pairingOutcome(diff)).toEqual([
      "moved emptyIR -> emptyIR (logic-fingerprint+name-disambiguation)",
      "removed makeEmptyIR",
    ])
    expect(diff.symbols.find((change) => change.status === "removed")).toMatchObject({
      duplicateOf: "ts:src/fixtures.ts#emptyIR",
    })
    expect(diff.summary).toMatchObject({ removed: 1, removedDuplicates: 1 })
  })

  const guarded = (name: string, then: string) =>
    `export function ${name}(tree: Tree | null): void {\n  if (tree === null) throw new Error("no tree")\n  ${then}\n}\n`

  it.each([
    ["the same body", "visit(tree)", "ts:src/a.ts#requireTree"],
    ["the same guard and another call after it", "print(tree)", null],
  ])("reads a helper deleted beside one with %s", async (_label, then, duplicateOf) => {
    const kept = guarded("requireTree", "visit(tree)")
    const diff = await diffOfMove(
      workspace,
      { "src/a.ts": kept, "src/b.ts": guarded("checkTree", then) },
      { "src/a.ts": kept },
    )

    expect(pairingOutcome(diff)).toEqual(["removed checkTree"])
    expect(diff.symbols[0]).toMatchObject({ duplicateOf })
  })
})
