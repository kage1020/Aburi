import { fp, makeSymbol } from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src/diff"
import { emptySummary, makeDiff } from "./fixtures"

/** markdown-projection.md MP11b: a pair across a rename writes the old name wherever it is shown. */

function symbol(id: string, name: string, startLine: number, edited = false): IRSymbol {
  const base = makeSymbol({
    id,
    name,
    fingerprint: edited ? { ...fp("v1"), api: fp("v2").api } : fp("v1"),
  })
  return { ...base, source: { ...base.source, startLine, endLine: startLine + 3 } }
}

function delta(overrides: Partial<SymbolDelta> = {}): SymbolDelta {
  return {
    apiChanged: true,
    logicChanged: false,
    syntaxChanged: true,
    componentChanged: false,
    visibilityChanged: false,
    rules: { added: [], removed: [], modified: [] },
    effects: { added: [], removed: [], modified: [] },
    calls: { added: [], removed: [], modified: [] },
    decorators: { added: [], removed: [], modified: [] },
    signature: null,
    ...overrides,
  }
}

const renamedAcrossFiles: SymbolChange = {
  status: "moved+changed",
  before: symbol("ts:src/parse.ts#parseAmount", "parseAmount", 1),
  after: symbol("ts:src/amount.ts#readAmount", "readAmount", 1, true),
  rationale: "logic-fingerprint",
  delta: delta(),
}

const renamedInFile: SymbolChange = {
  status: "moved+changed",
  before: symbol("ts:src/money.ts#convertCurrency", "convertCurrency", 1),
  after: symbol("ts:src/money.ts#convertCurrencyAmount", "convertCurrencyAmount", 1, true),
  rationale: "logic-fingerprint",
  delta: delta(),
}

const reownedInFile: SymbolChange = {
  status: "moved",
  before: symbol("ts:src/money.ts#InvoiceStore.loadInvoice", "InvoiceStore.loadInvoice", 6),
  after: symbol("ts:src/money.ts#InvoiceStores.loadInvoice", "InvoiceStores.loadInvoice", 6),
  rationale: "logic-fingerprint",
}

const movedAndRenamed: SymbolChange = {
  status: "moved",
  before: symbol("ts:src/util.ts#slug", "slug", 7),
  after: symbol("ts:src/text/slug.ts#toSlug", "toSlug", 1),
  rationale: "logic-fingerprint",
}

const diff = makeDiff({
  summary: { ...emptySummary(), moved: 2, movedChanged: 2 },
  symbols: [renamedAcrossFiles, renamedInFile, reownedInFile, movedAndRenamed],
})
const md = projectDiff(diff)

describe("a Symbol paired across a rename", () => {
  it("writes the old name in its delta, which explains the API flag", () => {
    expect(md).toContain("- name: `parseAmount` → `readAmount`")
    expect(md).toContain("- name: `convertCurrency` → `convertCurrencyAmount`")
    expect(md).not.toContain("no field-level detail was recorded")
  })

  it("writes the old name under API changes too, where the pair is titled by its new name", () => {
    const api = md.slice(md.indexOf("## ⚠ API changes"), md.indexOf("## 🔀 Moved + Changed"))
    expect(api).toContain("### `readAmount` *(function)*")
    expect(api).toContain("- name: `parseAmount` → `readAmount`")
  })

  it("names both sides with their files on a move between files", () => {
    expect(md).toContain(
      "**Moved**: `parseAmount` in `src/parse.ts` → `readAmount` in `src/amount.ts` (`logic-fingerprint`)",
    )
    expect(md).toContain(
      "- `slug` in `src/util.ts` → `toSlug` in `src/text/slug.ts` (`logic-fingerprint`)",
    )
  })

  it("keeps both names on a move within one file", () => {
    expect(md).toContain(
      "- within `src/money.ts`: `InvoiceStore.loadInvoice` (L6) → `InvoiceStores.loadInvoice` (L6)",
    )
  })

  it("writes the old name on the names-only row too", () => {
    const full = Buffer.byteLength(md, "utf8")
    let shortened: string | undefined
    for (let budget = full - 1; budget > 0 && shortened === undefined; budget -= 8) {
      const capped = projectDiff(diff, { maxBytes: budget })
      if (capped.includes("(from ")) shortened = capped
    }
    expect(shortened).toContain(
      "- `readAmount` *(function)* — `src/amount.ts:1` (from `parseAmount` in `src/parse.ts`)",
    )
  })

  it.each([
    ["Repo.save", "UserRepo.save"],
    ["Repo::save", "UserRepo::save"],
  ])("still notes an unexplained API flag when only the owner changed, %s → %s", (from, to) => {
    // The API fingerprint reads the last segment of the name, so a new owner explains nothing.
    const reowned: SymbolChange = {
      status: "moved+changed",
      before: symbol(`ts:src/repo.ts#${from}`, from, 3),
      after: symbol(`ts:src/repo.ts#${to}`, to, 3, true),
      rationale: "name-signature",
      delta: delta(),
    }
    const out = projectDiff(
      makeDiff({ summary: { ...emptySummary(), movedChanged: 1 }, symbols: [reowned] }),
    )
    expect(out).toContain(`- name: \`${from}\` → \`${to}\``)
    expect(out).toContain("- API fingerprint changed; no field-level detail was recorded")
  })
})
