import { rm } from "node:fs/promises"
import { join } from "node:path"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { IR, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith, warningCollector } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A body whose logic axis names nothing — a class, a function that only calls something, one
 * that is a single loop over calls — hashes alike across unrelated Symbols, so sharing it is no
 * evidence that two are one. Stage 3 used to pair a lone deleted one with whichever such head
 * was closest by name: a deleted function became a move into an unrelated class, and
 * `--fail-on removed` never saw the deletion. This runs the real pipeline, without git, so no
 * rename map can pair anything, and every scan has to be silent, so an extraction failure
 * cannot pass for a matcher outcome.
 */

const workspace = useScratchWorkspace("empty-logic-pairing")

async function scanSilently(): Promise<IR> {
  const { logger, warnings } = warningCollector()
  const { ir } = await scanWith(
    workspace.root,
    { languages: [langTypescriptPlugin] },
    {},
    { logger },
  )
  expect(warnings).toEqual([])
  return ir
}

/** Scan with `before` on disk, replace it with `after`, scan again, diff the two. */
async function diffOfChange(
  before: Record<string, string>,
  after: Record<string, string>,
): Promise<ReturnType<typeof diffIRs>> {
  for (const [file, text] of Object.entries(before)) await workspace.writeSource(file, text)
  const baseIR = await scanSilently()
  for (const file of Object.keys(before)) await rm(join(workspace.root, file))
  for (const [file, text] of Object.entries(after)) await workspace.writeSource(file, text)
  const headIR = await scanSilently()
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

/** The four counts these cases decide, all zero; each case raises the ones it expects. */
const NONE = { removed: 0, added: 0, moved: 0, movedChanged: 0 }

describe("e2e diff — Symbols whose logic axis names nothing", () => {
  it("DF19f: reports a deleted function as removed, not as moved into an unrelated class", async () => {
    const diff = await diffOfChange(
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
    expect(diff.summary).toMatchObject({ ...NONE, removed: 1, added: 2 })
    expect(outcome(diff)).toEqual([
      "added InvoiceRenderer",
      "added InvoiceRenderer.render",
      "removed sendWelcomeEmail",
    ])
  })

  it("DF19h: reports an unrelated function of the same kind as removed + added (no lone-base shortcut)", async () => {
    // Both names say more than one word and the kinds agree, so only the missing shortcut keeps
    // these apart. No `return`, or the logic axis would carry the returned expression.
    const diff = await diffOfChange(
      {
        "src/mail.ts":
          "export function sendWelcomeEmail(to: string): void {\n  mailer.send(to)\n}\n",
      },
      {
        "src/invoice.ts":
          "export function renderInvoiceTotal(total: number): void {\n  logger.log(total)\n}\n",
      },
    )
    expect(diff.summary).toMatchObject({ ...NONE, removed: 1, added: 1 })
  })

  it("DF19h: does the same for a body that is one `for` loop over calls", async () => {
    const diff = await diffOfChange(
      {
        "src/mail.ts":
          "export function sendAllEmails(xs: string[]): void {\n  for (const x of xs) mailer.send(x)\n}\n",
      },
      {
        "src/invoice.ts":
          "export function renderInvoiceRows(rows: number[]): void {\n  for (const r of rows) logger.log(r)\n}\n",
      },
    )
    expect(diff.summary).toMatchObject({ ...NONE, removed: 1, added: 1 })
  })

  it("DF19: reports two unrelated top-level `main`s as one removed and one added", async () => {
    const diff = await diffOfChange(
      { "src/tool-a.ts": "export function main(x: string): void {\n  runA(x)\n}\n" },
      {
        "src/tool-b.ts":
          "export function main(x: string): void {\n  const cfg = loadConfig(x)\n  runB(cfg)\n}\n",
      },
    )
    expect(diff.summary).toMatchObject({ ...NONE, removed: 1, added: 1 })
  })

  // The counterpart: a body that returns a non-trivial expression names something, whichever way
  // it is spelled. A concise arrow's expression is its `return` rule, so it pairs on logic alone
  // as its block twin does; read as a bare expression it named nothing, and these two names are
  // too far apart to pair on.
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
  ])("DF19i: pairs %s moved and renamed on its logic fingerprint", async (_label, write) => {
    const diff = await diffOfChange(
      { "src/a.ts": write("isAdminUser") },
      { "src/b.ts": write("canAdministerSite") },
    )
    expect(diff.summary).toMatchObject({ ...NONE, movedChanged: 1 })
    expect(outcome(diff)).toEqual([
      "moved+changed isAdminUser -> canAdministerSite (logic-fingerprint)",
    ])
  })

  it("DF19g: still reports a class whose name says two words as moved, with its method", async () => {
    const source = [
      "export class InvoiceRenderer {",
      "  render(total: number): string {",
      "    return total.toFixed(2)",
      "  }",
      "}",
      "",
    ].join("\n")
    const diff = await diffOfChange({ "src/old.ts": source }, { "src/new.ts": source })
    expect(outcome(diff)).toEqual([
      "moved InvoiceRenderer -> InvoiceRenderer (logic-fingerprint+name-disambiguation)",
      "moved InvoiceRenderer.render -> InvoiceRenderer.render (logic-fingerprint+name-disambiguation)",
    ])
  })

  it("DF19g: reports a class whose name says one word as removed + added, while its method moves", async () => {
    // The owner and its member pair independently, as a renamed class and its methods already
    // did; nothing reconciles the two.
    const source =
      "export class Invoice {\n  render(t: number) {\n    return t.toFixed(2)\n  }\n}\n"
    const diff = await diffOfChange({ "src/old.ts": source }, { "src/new.ts": source })
    expect(outcome(diff)).toEqual([
      "added Invoice",
      "moved Invoice.render -> Invoice.render (logic-fingerprint+name-disambiguation)",
      "removed Invoice",
    ])
  })
})
