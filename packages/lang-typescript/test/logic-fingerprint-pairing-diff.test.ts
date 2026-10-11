import { rm } from "node:fs/promises"
import { join } from "node:path"
import { diffIRs } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import type { SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { scanWithoutWarnings } from "./fixtures/scan"

const workspace = useScratchWorkspace("logic-fingerprint-pairing")

/** Scan `before`, delete its file, write `after` in another one, scan again, and diff the two. */
async function diffOfMove(
  before: Record<string, string>,
  after: Record<string, string>,
): Promise<ReturnType<typeof diffIRs>> {
  for (const [file, text] of Object.entries(before)) await workspace.writeSource(file, text)
  const baseIR = await scanWithoutWarnings(workspace.root)
  for (const file of Object.keys(before)) await rm(join(workspace.root, file))
  for (const [file, text] of Object.entries(after)) await workspace.writeSource(file, text)
  const headIR = await scanWithoutWarnings(workspace.root)
  return diffIRs(baseIR, headIR)
}

/** Every change, as status, names and the stage that paired it, in a stable order. */
function outcome(diff: ReturnType<typeof diffIRs>): string[] {
  return diff.symbols.map(describeChange).sort()
}

function describeChange(change: SymbolChange): string {
  if ("symbol" in change) return `${change.status} ${change.symbol.name}`
  const pairing = `${change.status} ${change.before.name} -> ${change.after.name}`
  return "rationale" in change ? `${pairing} (${change.rationale})` : pairing
}

describe("diff — pairing a Symbol that moved file on its logic fingerprint", () => {
  it("reports a deleted function whose logic names nothing as removed, not as moved", async () => {
    const diff = await diffOfMove(
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
    expect(outcome(diff)).toEqual([
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
      { "src/a.ts": write("isAdminUser") },
      { "src/b.ts": write("canAdministerSite") },
    )
    expect(outcome(diff)).toEqual([
      "moved+changed isAdminUser -> canAdministerSite (logic-fingerprint)",
    ])
  })
})
