import {
  changed,
  effect,
  errorFrom,
  makeDiff,
  makeSymbol,
  movedChanged,
  sliceId,
} from "@aburi/test-support"
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

function calls(symbol: IRSymbol, ...callees: Array<readonly [IRSymbol, number]>): IRSymbol {
  return {
    ...symbol,
    calls: callees.map(([callee, line]) => ({ target: callee.name, line, resolved: callee.id })),
  }
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

  it("draws a Slice as its calls, from the member nothing in it calls", () => {
    expect(
      sliceView(
        [
          logicChange(calls(ctl, [svc, 3])),
          logicChange(calls(svc, [repo, 5])),
          { status: "added", symbol: repo },
        ],
        [slice(ctl, repo, svc)],
      ),
    ).toEqual([
      HEADING,
      "",
      "### From `Ctl.route` (3 symbols)",
      "",
      "Files: `src/ctl.ts`, `src/repo.ts`, `src/svc.ts`",
      "",
      "- `Ctl.route` — logic changed · `ctl.ts:42`",
      "  - `Svc.op` — logic changed · `svc.ts:88`",
      "    - `Repo.save` — new function · `repo.ts:15`",
      "",
    ])
  })

  it("puts a caller's callees in the order it calls them and writes out a member once", () => {
    const tree = sliceView(
      [
        logicChange(calls(ctl, [repo, 9], [svc, 3])),
        logicChange(calls(svc, [repo, 5])),
        logicChange(repo),
      ],
      [slice(ctl, repo, svc)],
    ).filter((line) => line.trimStart().startsWith("- "))
    expect(tree).toEqual([
      "- `Ctl.route` — logic changed · `ctl.ts:42`",
      "  - `Svc.op` — logic changed · `svc.ts:88`",
      "    - `Repo.save` — logic changed · `repo.ts:15`",
      "  - `Repo.save` *(see above)*",
    ])
  })

  it("opens a ring of calls, which no member starts, at its first member", () => {
    const a = at("a", "src/a.ts", 1)
    const b = at("b", "src/b.ts", 1)
    const lines = sliceView(
      [logicChange(calls(a, [b, 2])), logicChange(calls(b, [a, 2]))],
      [slice(a, b)],
    )
    expect(lines).toContain("### From `a` (2 symbols)")
    expect(lines.filter((line) => line.trimStart().startsWith("- "))).toEqual([
      "- `a` — logic changed · `a.ts:1`",
      "  - `b` — logic changed · `b.ts:1`",
      "    - `a` *(see above)*",
    ])
  })

  it("carries a chain too deep to indent on from a row of its own", () => {
    const chain = Array.from({ length: 8 }, (_, i) => at(`c${i}`, "src/c.ts", i + 1))
    const lines = sliceView(
      chain.map((member, i) => {
        const next = chain[i + 1]
        return logicChange(next === undefined ? member : calls(member, [next, 1]))
      }),
      [slice(...chain)],
    )
    expect(lines.filter((line) => line.trimStart().startsWith("- "))).toEqual([
      "- `c0` — logic changed · `c.ts:1`",
      "  - `c1` — logic changed · `c.ts:2`",
      "    - `c2` — logic changed · `c.ts:3`",
      "      - `c3` — logic changed · `c.ts:4`",
      "        - `c4` — logic changed · `c.ts:5`",
      "          - `c5` — logic changed · `c.ts:6`",
      "- `c5` *(continued)*",
      "  - `c6` — logic changed · `c.ts:7`",
      "    - `c7` — logic changed · `c.ts:8`",
    ])
  })

  it("names three of the members it starts from and counts the rest", () => {
    const hub = at("hub", "src/hub.ts", 1)
    const starts = ["s1", "s2", "s3", "s4", "s5"].map((name) => at(name, "src/s.ts", 1))
    const lines = sliceView(
      [...starts.map((start) => logicChange(calls(start, [hub, 2]))), logicChange(hub)],
      [slice(...starts, hub)],
    )
    expect(lines).toContain("### From `s1`, `s2`, `s3` and 2 more (6 symbols)")
  })

  it("labels each file by the fewest trailing segments that tell it apart", () => {
    const a = at("a", "src/a/index.ts", 1)
    const b = at("b", "src/b/index.ts", 2)
    const c = at("c", "src/c.ts", 3)
    const lines = sliceView(
      [logicChange(calls(a, [b, 2])), logicChange(calls(b, [c, 3])), logicChange(c)],
      [slice(a, b, c)],
    )
    expect(lines).toContain("Files: `src/a/index.ts`, `src/b/index.ts`, `src/c.ts`")
    expect(lines.filter((line) => line.trimStart().startsWith("- "))).toEqual([
      "- `a` — logic changed · `a/index.ts:1`",
      "  - `b` — logic changed · `b/index.ts:2`",
      "    - `c` — logic changed · `c.ts:3`",
    ])
  })

  it("draws a call only the base made, between the members its ends became", () => {
    const formerRepo = at("Repo.save", "src/old-repo.ts", 3)
    const lines = sliceView(
      [
        changed(calls(ctl, [formerRepo, 4]), { logicChanged: true }, { calls: [] }),
        movedChanged(formerRepo, repo, { logicChanged: true }),
      ],
      [slice(ctl, repo)],
    )
    expect(lines).toContain(
      "  - `Repo.save` — moved: `src/old-repo.ts` → `src/repo.ts`; logic changed · `repo.ts:15`",
    )
  })

  it("orders a call both revisions make by its line in the head", () => {
    const lines = sliceView(
      [
        changed(
          calls(ctl, [svc, 9], [repo, 3]),
          { logicChanged: true },
          { calls: calls(ctl, [svc, 3], [repo, 9]).calls },
        ),
        logicChange(svc),
        logicChange(repo),
      ],
      [slice(ctl, repo, svc)],
    )
    expect(lines.filter((line) => line.startsWith("  - "))).toEqual([
      "  - `Svc.op` — logic changed · `svc.ts:88`",
      "  - `Repo.save` — logic changed · `repo.ts:15`",
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
  ])("describes %s on its row", (_, change, followUp) => {
    expect(sliceView([change, logicChange(ctl)], [slice(ctl, repo)])).toContain(
      `- \`Repo.save\` — ${followUp} · \`repo.ts:15\``,
    )
  })

  it("writes Slices in the order given", () => {
    const a = at("a", "src/a.ts", 1)
    const b = at("b", "src/b.ts", 1)
    const lines = sliceView(
      [
        logicChange(svc),
        logicChange(calls(ctl, [svc, 2])),
        logicChange(calls(a, [b, 2])),
        logicChange(b),
      ],
      [slice(svc, ctl), slice(a, b)],
    )
    expect(lines.filter((line) => line.startsWith("### "))).toEqual([
      "### From `Ctl.route` (2 symbols)",
      "### From `a` (2 symbols)",
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
      "- `formatMoney` — logic changed · `src/util.ts:3`",
      "- `Repo.save` — logic changed · `src/repo.ts:15`",
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

  const format = at("format", "src/format.ts", 4)

  function crossing(caller: IRSymbol): string[] {
    return sliceView(
      [logicChange(caller), logicChange(svc), logicChange(repo), logicChange(format)],
      [slice(caller, svc), slice(repo, format)],
    )
  }

  it.each<[string, string[], string]>([
    [
      "one call",
      ["getRepo.save"],
      "> ⚠ 1 call below names a changed symbol in another Slice but was not resolved to it, so those Slices may belong together.",
    ],
    [
      "several calls",
      ["this.repo.save", "format"],
      "> ⚠ 2 calls below name a changed symbol in another Slice but were not resolved to it, so those Slices may belong together.",
    ],
  ])("totals the calls naming a member of another Slice under the heading, for %s", (_, targets, note) => {
    expect(crossing(calling("Ctl.route", "src/ctl.ts", ...targets))[2]).toBe(note)
  })

  it("marks the member making such a call, naming each target once", () => {
    const lines = crossing(
      calling("Ctl.route", "src/ctl.ts", "getRepo.save", "join", "getRepo.save"),
    )
    expect(lines).toContain(
      "- `Ctl.route` — logic changed · `ctl.ts:1` · ⚠ unresolved call to `getRepo.save`",
    )
    expect(lines).toContain("- `Svc.op` — logic changed · `svc.ts:88`")
  })

  it.each<[string, string, string]>([
    ["a method through a receiver named after its class", "Ctl.route", "this.repo.save"],
    ["a method through `this` in a class whose name holds its own", "UserRepo.load", "this.save"],
    ["a plain function by a bare call", "Ctl.route", "format"],
  ])("takes a call to %s as such a call", (_, caller, target) => {
    expect(crossing(calling(caller, "src/ctl.ts", target)).join("\n")).toContain(
      `⚠ unresolved call to ${"`"}${target}${"`"}`,
    )
  })

  it("marks a singleton that makes such a call, an added one included", () => {
    const added = calling("addedFn", "src/add.ts", "Repo.save", "Svc.op")
    expect(
      sliceView(
        [{ status: "added", symbol: added }, logicChange(repo), logicChange(svc)],
        [slice(added), slice(repo, svc)],
      ),
    ).toContain(
      "- `addedFn` — new function · `src/add.ts:1` · ⚠ unresolved calls to `Repo.save`, `Svc.op`",
    )
  })

  it.each<[string, string]>([
    ["a target no changed symbol is named after", "rows.push"],
    ["a member of its own Slice", "svc.op"],
    ["a target whose last segment is computed", "handlers.<computed>"],
    ["a method through a receiver that names another class", "user.save"],
    ["a method by a bare call", "save"],
    ["a plain function through a receiver", "id.format"],
  ])("says nothing about an unresolved call to %s", (_, target) => {
    expect(crossing(calling("Ctl.route", "src/ctl.ts", target)).join("\n")).not.toContain("⚠")
  })
})
