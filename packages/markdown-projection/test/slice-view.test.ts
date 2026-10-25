import { changed, effect, errorFrom, makeDiff, makeSymbol, sliceId } from "@aburi/test-support"
import type { Symbol as IRSymbol, SliceRecord, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { ProjectionInvariantError, projectDiff } from "../src"
import { sectionOf } from "./markdown"

const HEADING = "## 🧵 Slice View"

function at(name: string, file: string, startLine: number): IRSymbol {
  const symbol = makeSymbol({ id: `ts:${file}#${name}`, name })
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
      "  ↳ logic changed",
      "- `Repo.save` — *(added)*",
      "  **File**: `src/repo.ts:15`",
      "  ↳ new function",
      "- `Svc.op` — *(changed)*",
      "  **File**: `src/svc.ts:88`",
      "  ↳ logic changed",
      "",
      "---",
      "",
    ])
  })

  it.each<[string, SymbolChange, string]>([
    ["a removed Symbol by its kind", { status: "removed", symbol: repo }, "removed function"],
    [
      "an added Symbol by its kind and the effects it has",
      {
        status: "added",
        symbol: {
          ...repo,
          kind: "method",
          effects: [
            effect({
              id: "db.write",
              target: "prisma.user.create",
              plugin: "effects-prisma",
              line: 3,
            }),
            effect({ id: "event.publish", target: "bus.emit", plugin: "effects-events", line: 4 }),
            effect({
              id: "db.write",
              target: "prisma.audit.create",
              plugin: "effects-prisma",
              line: 5,
            }),
          ],
        },
      },
      "new method with db.write, event.publish",
    ],
    [
      "a Symbol that became boilerplate",
      {
        status: "dropped-toggled",
        before: repo,
        after: { ...repo, dropped: true, dropReason: "DTO" },
        direction: "to-dropped",
      },
      "now dropped",
    ],
    [
      "a Symbol that stopped being boilerplate",
      { status: "dropped-toggled", before: repo, after: repo, direction: "to-kept" },
      "no longer dropped",
    ],
    [
      "every axis that moved, in words",
      changed(repo, {
        apiChanged: true,
        syntaxChanged: true,
        componentChanged: true,
        visibilityChanged: true,
      }),
      "API, syntax, component and visibility changed",
    ],
    ["two axes", changed(repo, { apiChanged: true, logicChanged: true }), "API and logic changed"],
    ["a syntax change alone", changed(repo, { syntaxChanged: true }), "syntax only"],
    [
      "a confidence change",
      changed(repo, { confidenceChanged: true }, { confidence: "medium" }),
      "confidence changed",
    ],
    ["a change with no axis set", changed(repo), "nothing flagged"],
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

  it("folds the singleton Slices into one block after the others, one row per member", () => {
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
      "<summary>2 symbols with no resolved call to or from another changed symbol</summary>",
      "",
      "- `formatMoney` — *(changed)* · `src/util.ts:3` · logic changed",
      "- `Repo.save` — *(changed)* · `src/repo.ts:15` · logic changed",
      "",
      "</details>",
      "",
    ])
  })

  it("writes only the fold when every Slice is a singleton", () => {
    const lines = sliceView([logicChange(ctl), logicChange(svc)], [slice(ctl), slice(svc)])
    expect(lines.slice(0, 4)).toEqual([HEADING, "", "### Standalone changes", ""])
  })

  it.each<[string, SliceRecord, string, string]>([
    [
      "a member that has no change in the diff",
      slice(ctl, svc),
      `a diff.symbols[] entry for member ${svc.id}`,
      `Slice(id=slice:${ctl.id})`,
    ],
    [
      "no members",
      { id: sliceId("slice:empty"), members: [] },
      "members[0]",
      "Slice(id=slice:empty)",
    ],
  ])("refuses a Slice with %s, naming what it lacks and the Slice", async (_label, invalid, field, subject) => {
    const error = await errorFrom(ProjectionInvariantError, () =>
      sliceView([logicChange(ctl)], [invalid]),
    )
    expect(error).toMatchObject({ field, subject })
  })
})

describe("projectDiff — unresolved calls in the Slice View", () => {
  function calling(name: string, file: string, ...targets: string[]): IRSymbol {
    return {
      ...at(name, file, 1),
      calls: targets.map((target, i) => ({ target, line: 2 + i, resolved: null })),
    }
  }

  it.each<[string, string[], string]>([
    [
      "one call",
      ["getRepo.save"],
      "> ⚠ 1 call below names a changed symbol in another Slice but was not resolved to it, so those Slices may belong together.",
    ],
    [
      "several calls",
      ["this.repo.save", "save"],
      "> ⚠ 2 calls below name a changed symbol in another Slice but were not resolved to it, so those Slices may belong together.",
    ],
  ])("totals the calls naming a member of another Slice under the heading, for %s", (_, targets, note) => {
    const ctlCalling = calling("Ctl.route", "src/ctl.ts", ...targets)
    const lines = sliceView(
      [logicChange(ctlCalling), logicChange(svc), logicChange(repo)],
      [slice(ctlCalling, svc), slice(repo)],
    )
    expect(lines[2]).toBe(note)
  })

  it("marks the member making such a call, naming each target once", () => {
    const ctlCalling = calling("Ctl.route", "src/ctl.ts", "getRepo.save", "join", "getRepo.save")
    const lines = sliceView(
      [logicChange(ctlCalling), logicChange(svc), logicChange(repo)],
      [slice(ctlCalling, svc), slice(repo)],
    )
    expect(lines).toContain("  ↳ logic changed · ⚠ unresolved call to `getRepo.save`")
    expect(lines).toContain("  ↳ logic changed")
  })

  it("marks a singleton that makes such a call, an added one included", () => {
    const added = calling("addedFn", "src/add.ts", "Repo.save", "Svc.op")
    expect(
      sliceView(
        [{ status: "added", symbol: added }, logicChange(repo), logicChange(svc)],
        [slice(added), slice(repo, svc)],
      ),
    ).toContain(
      "- `addedFn` — *(added)* · `src/add.ts:1` · new function · ⚠ unresolved calls to `Repo.save`, `Svc.op`",
    )
  })

  it.each<[string, string]>([
    ["a target no changed symbol is named after", "rows.push"],
    ["a member of its own Slice", "this.op"],
    ["a target whose last segment is computed", "handlers.<computed>"],
  ])("says nothing about an unresolved call to %s", (_, target) => {
    const ctlCalling = calling("Ctl.route", "src/ctl.ts", target)
    const lines = sliceView(
      [logicChange(ctlCalling), logicChange(svc), logicChange(repo)],
      [slice(ctlCalling, svc), slice(repo)],
    )
    expect(lines.join("\n")).not.toContain("⚠")
  })
})
