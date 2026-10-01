import { rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { diffIRs, scanFixture } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A body with no rules and no effects — a class, or a function that only calls something —
 * has the same logic fingerprint as every other one, so sharing it is no evidence that two
 * Symbols are one. Stage 3 used to pair a lone deleted one with whichever such head was
 * closest by name: a deleted function became a move into an unrelated class, and
 * `--fail-on removed` never saw the deletion. This runs the real pipeline, without git, so no
 * rename map can pair anything.
 */

const workspace = useScratchWorkspace("empty-logic-pairing")

/** Scan with `before` on disk, replace it with `after`, scan again, diff the two. */
async function diffOfChange(
  before: Record<string, string>,
  after: Record<string, string>,
): Promise<ReturnType<typeof diffIRs>> {
  for (const [file, text] of Object.entries(before)) await workspace.writeSource(file, text)
  const baseIR = (await scanFixture(workspace.root)).ir
  for (const file of Object.keys(before)) await rm(join(workspace.root, file))
  for (const [file, text] of Object.entries(after)) await workspace.writeSource(file, text)
  const headIR = (await scanFixture(workspace.root)).ir
  return diffIRs(baseIR, headIR)
}

describe("e2e diff — Symbols whose logic axis is empty", () => {
  it("reports a deleted function as removed, not as moved into an unrelated class", async () => {
    const diff = await diffOfChange(
      {
        "src/mail.ts": [
          "export function sendWelcomeEmail(to: string): void {",
          "  mailer.send(to)",
          "}",
          "",
        ].join("\n"),
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
    expect(diff.summary).toMatchObject({ removed: 1, added: 2, moved: 0, movedChanged: 0 })
    const removed = diff.symbols.find((c) => c.status === "removed")
    expect(removed?.status === "removed" ? removed.symbol.name : null).toBe("sendWelcomeEmail")
  })

  it("DF19: reports two unrelated top-level `main`s as one removed and one added", async () => {
    const diff = await diffOfChange(
      { "src/tool-a.ts": "export function main(x: string): void {\n  runA(x)\n}\n" },
      {
        "src/tool-b.ts":
          "export function main(x: string): void {\n  const cfg = loadConfig(x)\n  runB(cfg)\n}\n",
      },
    )
    expect(diff.summary).toMatchObject({ removed: 1, added: 1, moved: 0, movedChanged: 0 })
  })

  it("still reports a class that moved file as moved", async () => {
    const source = "export class InvoiceRenderer {\n  label = 'invoice'\n}\n"
    const diff = await diffOfChange({ "src/old.ts": source }, { "src/new.ts": source })
    expect(diff.summary).toMatchObject({ removed: 0, added: 0, moved: 1 })
  })
})
