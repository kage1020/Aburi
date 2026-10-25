import { changed, componentId, makeSymbol, movedChanged } from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectChanges, renamedPair } from "./fixtures"

const f = makeSymbol({ id: "ts:src/a.ts#f", name: "f" })
const note = (side: string) => `- ${side} fingerprint changed; no field-level detail was recorded`

describe("the note under a fingerprint flag no row explains", () => {
  it.each<[string, Partial<SymbolDelta>, string]>([
    ["a logic change", { logicChanged: true }, "logic"],
    ["an API change", { apiChanged: true }, "API"],
    ["an API and logic change, by the API side", { apiChanged: true, logicChanged: true }, "API"],
  ])("names %s that carries no field-level detail", (_, flags, side) => {
    const md = projectChanges([changed(f, flags)])
    expect(md).toContain(note(side))
    expect(md.match(/fingerprint changed/g)).toHaveLength(1)
  })

  it("names a syntax-only moved+changed entry, which no other section renders", () => {
    const md = projectChanges([
      movedChanged(f, makeSymbol({ id: "ts:src/b.ts#f", name: "f" }), { syntaxChanged: true }),
    ])
    expect(md).toContain(`**Delta**:\n${note("syntax")}\n`)
  })

  it.each<[string, Partial<SymbolDelta>, Partial<IRSymbol>, string, string]>([
    [
      "component",
      { logicChanged: true, componentChanged: true },
      { component: componentId("core") },
      "- component: none → `core`",
      "logic",
    ],
    [
      "confidence",
      { syntaxChanged: true, confidenceChanged: true },
      { confidence: "medium" },
      "- confidence: `high` → `medium`",
      "syntax",
    ],
  ])("stays beside a %s row, which no fingerprint reads", (_, flags, after, row, side) => {
    const md = projectChanges([changed(f, flags, after)])
    expect(md).toContain(row)
    expect(md).toContain(note(side))
  })

  it.each<[string, Partial<SymbolDelta>, string]>([
    [
      "visibility",
      { apiChanged: true, visibilityChanged: true },
      "- visibility: `public` → `internal`",
    ],
    [
      "rule",
      {
        logicChanged: true,
        rules: { added: [{ type: "try", line: 2 }], removed: [], modified: [] },
      },
      "  - try (L2)",
    ],
  ])("gives way to a %s row, which explains the fingerprint", (_, flags, row) => {
    const md = projectChanges([changed(f, flags, { visibility: "internal" })])
    expect(md).toContain(row)
    expect(md).not.toContain("no field-level detail")
  })

  it.each([
    ["parseAmount", "readAmount"],
    ["Repo.save", "Repo.persist"],
    ["C::Inner.g", "C::Inner.h"],
  ])("gives way to a name row whose last segment changed, %s → %s", (from, to) => {
    const md = projectChanges([renamedPair(from, "src/a.ts", to, "src/a.ts")])
    expect(md).toContain(`- name: \`${from}\` → \`${to}\``)
    expect(md).not.toContain("no field-level detail")
  })

  it.each([
    ["a new owner", "Repo.save", "UserRepo.save"],
    ["a new owner", "Repo::save", "UserRepo::save"],
    ["a new owner", "A.B.save", "A.C.save"],
    ["a new owner", "C::Inner.g", "C::Outer.g"],
    ["a new separator", "Repo.save", "Repo::save"],
  ])("does not count %s as explaining the API flag, %s → %s", (_, from, to) => {
    const md = projectChanges([renamedPair(from, "src/a.ts", to, "src/a.ts")])
    expect(md).toContain(`- name: \`${from}\` → \`${to}\``)
    expect(md).toContain(note("API"))
  })

  it("is not written for a change no fingerprint flag records", () => {
    const md = projectChanges([changed(f, { confidenceChanged: true }, { confidence: "low" })])
    expect(md).toContain("- confidence: `high` → `low`")
    expect(md).not.toContain("no field-level detail")
  })
})
