import { describe, expect, it } from "vitest"
import { diffIRs, scanFixture } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * An operator in an assignment, a call argument or a loop header sits in no rule's text, so
 * neither `api` nor `logic` sees it, and only `syntax` can. The normalized string used to be
 * built from named nodes alone, which leaves every operator out of it: `a + b` → `a - b` moved
 * no fingerprint, and the diff reported the Symbol as unchanged. This runs the real pipeline:
 * scan, edit on disk, scan again, diff.
 */

const workspace = useScratchWorkspace("operator-edit")

/** Scan `before`, rewrite the one source file to `after`, scan again, diff the two. */
async function diffOfEdit(before: string, after: string): Promise<ReturnType<typeof diffIRs>> {
  await workspace.writeSource("src/ledger.ts", before)
  const baseIR = (await scanFixture(workspace.root)).ir
  await workspace.writeSource("src/ledger.ts", after)
  const headIR = (await scanFixture(workspace.root)).ir
  return diffIRs(baseIR, headIR)
}

const ledger = (credit: string, gate: string, bound: string) =>
  [
    "export function applyCredit(balance: number, amount: number): number {",
    `  const next = balance ${credit} amount`,
    "  save(next)",
    "  return next",
    "}",
    "",
    "export function canDelete(isOwner: boolean, isAdmin: boolean): void {",
    `  audit(isOwner ${gate} isAdmin)`,
    "}",
    "",
    "export function sumAll(xs: number[]): number {",
    "  let total = 0",
    `  for (let i = 0; i ${bound} xs.length; i++) {`,
    "    total += xs[i]",
    "  }",
    "  return total",
    "}",
    "",
  ].join("\n")

describe("e2e diff — an operator edit outside every rule", () => {
  it("reports each edited function as a syntax-only change", async () => {
    const diff = await diffOfEdit(ledger("+", "&&", "<"), ledger("-", "||", "<="))

    expect(diff.summary).toMatchObject({ changed: 3, unchanged: 0, added: 0, removed: 0 })
    const changed = diff.symbols.flatMap((c) =>
      c.status === "changed" ? [{ name: c.after.name, ...c.delta }] : [],
    )
    expect(changed.map((c) => c.name).sort()).toEqual(["applyCredit", "canDelete", "sumAll"])
    for (const c of changed) {
      expect(c).toMatchObject({ apiChanged: false, logicChanged: false, syntaxChanged: true })
    }
  })

  it("reports a quote-style edit as no change", async () => {
    const diff = await diffOfEdit(
      "export function tag(x: string): void {\n  save(x, 'draft')\n}\n",
      'export function tag(x: string): void {\n  save(x, "draft",)\n}\n',
    )
    expect(diff.summary).toMatchObject({ changed: 0, unchanged: 1 })
  })
})
