import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith, warningCollector } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

const workspace = useScratchWorkspace("operator-edit")

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

/** Scan `before`, rewrite the one source file to `after`, scan again, diff the two. */
async function diffOfEdit(before: string, after: string): Promise<ReturnType<typeof diffIRs>> {
  await workspace.writeSource("src/ledger.ts", before)
  const baseIR = await scanSilently()
  await workspace.writeSource("src/ledger.ts", after)
  const headIR = await scanSilently()
  return diffIRs(baseIR, headIR)
}

/** Every Symbol counter of a diff's summary at zero; a case raises the ones it expects. */
const NONE = {
  added: 0,
  removed: 0,
  moved: 0,
  movedChanged: 0,
  changed: 0,
  unchanged: 0,
  droppedToggled: 0,
  droppedAdded: 0,
  droppedRemoved: 0,
  unknown: 0,
}

/** Only the syntax axis moved. */
const SYNTAX_ONLY = {
  apiChanged: false,
  logicChanged: false,
  syntaxChanged: true,
  visibilityChanged: false,
  componentChanged: false,
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

    expect(diff.summary).toMatchObject({ ...NONE, changed: 3 })
    const changed = diff.symbols.flatMap((c) =>
      c.status === "changed" ? [{ name: c.after.name, ...c.delta }] : [],
    )
    expect(changed.map((c) => c.name).sort()).toEqual(["applyCredit", "canDelete", "sumAll"])
    for (const c of changed) expect(c).toMatchObject(SYNTAX_ONLY)
  })

  it("reports a quote-style edit and a trailing comma as no change", async () => {
    const diff = await diffOfEdit(
      "export function tag(x: string): void {\n  save(x, 'draft')\n}\n",
      'export function tag(x: string): void {\n  save(x, "draft",)\n}\n',
    )
    expect(diff.symbols).toEqual([])
    expect(diff.summary).toMatchObject({ ...NONE, unchanged: 1 })
  })

  it("reports dropping a hole from a destructuring pattern as a syntax-only change", async () => {
    const bearer = (pattern: string) =>
      [
        "export function bearer(header: string): string {",
        `  const ${pattern} = header.split(" ")`,
        "  return token",
        "}",
        "",
      ].join("\n")
    const diff = await diffOfEdit(bearer("[, token]"), bearer("[token]"))

    expect(diff.summary).toMatchObject({ ...NONE, changed: 1 })
    expect(diff.symbols.map((c) => (c.status === "changed" ? c.delta : c.status))).toEqual([
      expect.objectContaining(SYNTAX_ONLY),
    ])
  })
})
