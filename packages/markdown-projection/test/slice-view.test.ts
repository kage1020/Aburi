import { changed, makeDiff, makeSymbol, sliceId } from "@aburi/test-support"
import type { Symbol as IRSymbol, SliceRecord, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { sectionOf } from "./markdown"

const HEADING = "## 🧵 Slice View"

function at(name: string, file: string, startLine: number, unresolvedCalls = 0): IRSymbol {
  const symbol = makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    calls: Array.from({ length: unresolvedCalls }, (_, i) => ({
      target: `mystery${i}`,
      line: 20 + i,
      resolved: null,
    })),
  })
  return { ...symbol, source: { ...symbol.source, startLine } }
}

const logicChange = (symbol: IRSymbol): SymbolChange => changed(symbol, { logicChanged: true })

function slice(...members: IRSymbol[]): SliceRecord {
  return { id: sliceId(`slice:${members[0]?.id}`), members: members.map((m) => m.id) }
}

function sliceView(symbols: SymbolChange[], slices: SliceRecord[]): string[] {
  return sectionOf(projectDiff(makeDiff({ symbols, slices })), HEADING)
}

const ctl = at("Ctl.route", "src/ctl.ts", 42)
const svc = at("Svc.op", "src/svc.ts", 88)
const repo = at("Repo.save", "src/repo.ts", 15)

describe("projectDiff — the Slice View", () => {
  it("is left out when there are no Slices", () => {
    expect(projectDiff(makeDiff({ symbols: [logicChange(ctl)] }))).not.toContain("Slice View")
  })

  it("lists each member of a Slice by name, status, location and what changed", () => {
    expect(
      sliceView(
        [logicChange(ctl), logicChange(svc), { status: "added", symbol: repo }],
        [slice(ctl, repo, svc)],
      ),
    ).toEqual([
      HEADING,
      "",
      "### `slice:ts:src/ctl.ts#Ctl.route` (3 members)",
      "",
      "- `Ctl.route` — *(changed)*",
      "  **File**: `src/ctl.ts:42`",
      "  ↳ delta.logicChanged",
      "- `Repo.save` — *(added)*",
      "  **File**: `src/repo.ts:15`",
      "  ↳ new symbol",
      "- `Svc.op` — *(changed)*",
      "  **File**: `src/svc.ts:88`",
      "  ↳ delta.logicChanged",
      "",
      "---",
      "",
    ])
  })

  it.each<[string, SymbolChange, string]>([
    ["a removed Symbol", { status: "removed", symbol: repo }, "removed symbol"],
    [
      "a Symbol whose dropped flag flipped",
      {
        status: "dropped-toggled",
        before: repo,
        after: { ...repo, dropped: true, dropReason: "DTO" },
        direction: "to-dropped",
      },
      "dropped-toggled: to-dropped",
    ],
    [
      "every axis that moved",
      changed(repo, {
        apiChanged: true,
        syntaxChanged: true,
        componentChanged: true,
        visibilityChanged: true,
      }),
      "delta.apiChanged, delta.syntaxChanged, delta.componentChanged, delta.visibilityChanged",
    ],
    [
      "a confidence change",
      changed(repo, { confidenceChanged: true }, { confidence: "medium" }),
      "delta.confidenceChanged",
    ],
    ["a change with no axis set", changed(repo), "no delta axes"],
  ])("follows up %s", (_, change, followUp) => {
    expect(sliceView([change, logicChange(ctl)], [slice(ctl, repo)])).toContain(`  ↳ ${followUp}`)
  })

  it("separates Slices by a thematic break, in the order given", () => {
    const a = at("a", "src/a.ts", 1)
    const b = at("b", "src/b.ts", 1)
    const lines = sliceView(
      [logicChange(svc), logicChange(ctl), logicChange(a), logicChange(b)],
      [slice(svc, ctl), slice(a, b)],
    )
    expect(lines.filter((line) => line.startsWith("### ") || line === "---")).toEqual([
      "### `slice:ts:src/svc.ts#Svc.op` (2 members)",
      "---",
      "### `slice:ts:src/a.ts#a` (2 members)",
      "---",
    ])
  })

  it("folds the singleton Slices into one block after the others, each labelled by its member", () => {
    const solo = at("formatMoney", "src/util.ts", 3)
    const lines = sliceView(
      [logicChange(ctl), logicChange(svc), logicChange(solo), logicChange(repo)],
      [
        slice(ctl, svc),
        slice(solo),
        { id: sliceId("slice:ts:src/elsewhere.ts#other"), members: [repo.id] },
      ],
    )
    expect(lines.slice(lines.indexOf("### Standalone changes"))).toEqual([
      "### Standalone changes",
      "",
      "<details>",
      "<summary>2 singleton slices (no in-Node call-graph neighbours)</summary>",
      "",
      "- `slice:ts:src/util.ts#formatMoney` — `formatMoney` *(changed)*",
      "- `slice:ts:src/elsewhere.ts#other` — `Repo.save` *(changed)*",
      "",
      "</details>",
      "",
    ])
  })

  it("writes only the fold when every Slice is a singleton", () => {
    const lines = sliceView([logicChange(ctl), logicChange(svc)], [slice(ctl), slice(svc)])
    expect(lines.slice(0, 4)).toEqual([HEADING, "", "### Standalone changes", ""])
  })

  it("refuses a Slice member that has no change in the diff", () => {
    expect(() => sliceView([logicChange(ctl)], [slice(ctl, svc)])).toThrow(
      /slice slice:ts:src\/ctl\.ts#Ctl\.route lists member ts:src\/svc\.ts#Svc\.op that is not present in diff\.symbols\[\]/,
    )
  })

  it("refuses a Slice with no members", () => {
    expect(() =>
      sliceView([logicChange(ctl)], [{ id: sliceId("slice:empty"), members: [] }]),
    ).toThrow(/slice slice:empty has an empty members\[\]/)
  })
})

describe("projectDiff — unresolved calls in the Slice View", () => {
  it.each<[string, number[], string]>([
    [
      "one member",
      [3, 0],
      "> ⚠ 1 of the changed symbols below makes 3 calls the resolver could not identify, so a Slice here may be split rather than genuinely disconnected.",
    ],
    [
      "several members",
      [1, 2],
      "> ⚠ 2 of the changed symbols below make 3 calls the resolver could not identify, so a Slice here may be split rather than genuinely disconnected.",
    ],
    [
      "one call",
      [1, 0],
      "> ⚠ 1 of the changed symbols below makes 1 call the resolver could not identify, so a Slice here may be split rather than genuinely disconnected.",
    ],
  ])("totals them under the heading for %s", (_, counts, note) => {
    const [first = 0, second = 0] = counts
    const a = at("a", "src/a.ts", 1, first)
    const b = at("b", "src/b.ts", 1, second)
    expect(sliceView([logicChange(a), logicChange(b)], [slice(a, b)])[2]).toBe(note)
  })

  it("marks the affected member of a Slice", () => {
    const lines = sliceView(
      [logicChange(at("Ctl.route", "src/ctl.ts", 42, 3)), logicChange(svc)],
      [slice(ctl, svc)],
    )
    expect(lines).toContain("  ↳ delta.logicChanged · ⚠ 3 unresolved calls")
    expect(lines).toContain("  ↳ delta.logicChanged")
  })

  it("marks an affected singleton, counting an added member's own calls", () => {
    const added = at("addedFn", "src/add.ts", 15, 1)
    expect(sliceView([{ status: "added", symbol: added }], [slice(added)])).toContain(
      "- `slice:ts:src/add.ts#addedFn` — `addedFn` *(added)* · ⚠ 1 unresolved call",
    )
  })

  it("says nothing when every member resolved cleanly", () => {
    const lines = sliceView([logicChange(ctl), logicChange(svc)], [slice(ctl, svc)])
    expect(lines.join("\n")).not.toContain("⚠")
  })
})
