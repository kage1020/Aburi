import {
  changed,
  effect,
  errorFrom,
  makeDiff,
  movedChanged,
  sliceId,
  sliceOf,
  symbolAt,
  withCallsTo,
} from "@aburi/test-support"
import type { Symbol as IRSymbol, SliceRecord, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { ProjectionInvariantError, projectDiff } from "../src"
import { sectionOf } from "./markdown"

const HEADING = "## 🧵 Slice View"

const logicChange = (symbol: IRSymbol): SymbolChange => changed(symbol, { logicChanged: true })

function sliceView(symbols: SymbolChange[], slices: SliceRecord[]): string[] {
  return sectionOf(projectDiff(makeDiff({ symbols, slices })), HEADING)
}

/** The rows of the call trees, members and continuations alike. */
function treeRows(lines: readonly string[]): string[] {
  return lines.filter((line) => line.trimStart().startsWith("- "))
}

/** Each member calling the next. */
function chain(prefix: string, length: number): IRSymbol[] {
  const members = Array.from({ length }, (_, i) => symbolAt("src/c.ts", `${prefix}${i}`, i + 1))
  return members.map((member, i) => {
    const next = members[i + 1]
    return next === undefined ? member : withCallsTo(member, [next, 1])
  })
}

const ctl = symbolAt("src/ctl.ts", "Ctl.route", 42)
const svc = symbolAt("src/svc.ts", "Svc.op", 88)
const repo = symbolAt("src/repo.ts", "Repo.save", 15)

describe("projectDiff — the Slice View", () => {
  it("is left out when there are no Slices", () => {
    expect(projectDiff(makeDiff({ symbols: [logicChange(ctl)] }))).not.toContain("Slice View")
  })

  it("draws a Slice as its calls, from the member nothing in it calls", () => {
    expect(
      sliceView(
        [
          logicChange(withCallsTo(ctl, [svc, 3])),
          logicChange(withCallsTo(svc, [repo, 5])),
          { status: "added", symbol: repo },
        ],
        [sliceOf(ctl, repo, svc)],
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
    const lines = sliceView(
      [
        logicChange(withCallsTo(ctl, [repo, 9], [svc, 3])),
        logicChange(withCallsTo(svc, [repo, 5])),
        logicChange(repo),
      ],
      [sliceOf(ctl, repo, svc)],
    )
    expect(treeRows(lines)).toEqual([
      "- `Ctl.route` — logic changed · `ctl.ts:42`",
      "  - `Svc.op` — logic changed · `svc.ts:88`",
      "    - `Repo.save` — logic changed · `repo.ts:15`",
      "  - `Repo.save` *(see above)*",
    ])
  })

  it("starts from a member that calls only itself besides the others", () => {
    const a = symbolAt("src/x.ts", "a", 1)
    const b = symbolAt("src/x.ts", "b", 5)
    const lines = sliceView(
      [logicChange(withCallsTo(a, [a, 2], [b, 3])), logicChange(b)],
      [sliceOf(a, b)],
    )
    expect(lines).toContain("### From `a` (2 symbols)")
    expect(treeRows(lines)).toEqual([
      "- `a` — logic changed · `x.ts:1`",
      "  - `b` — logic changed · `x.ts:5`",
    ])
  })

  it("opens a ring of calls nothing outside it calls at its first member", () => {
    const a = symbolAt("src/a.ts", "a", 1)
    const b = symbolAt("src/b.ts", "b", 1)
    const lines = sliceView(
      [logicChange(withCallsTo(a, [b, 2])), logicChange(withCallsTo(b, [a, 2]))],
      [sliceOf(a, b)],
    )
    expect(lines).toContain("### From `a` (2 symbols)")
    expect(treeRows(lines)).toEqual([
      "- `a` — logic changed · `a.ts:1`",
      "  - `b` — logic changed · `b.ts:1`",
      "    - `a` *(see above)*",
    ])
  })

  it("opens a ring that calls another member at the ring, not at the member it calls", () => {
    const a = symbolAt("src/x.ts", "a", 1)
    const b = symbolAt("src/x.ts", "b", 10)
    const c = symbolAt("src/x.ts", "c", 20)
    const lines = sliceView(
      [
        logicChange(a),
        logicChange(withCallsTo(b, [c, 11])),
        logicChange(withCallsTo(c, [a, 21], [b, 22])),
      ],
      [sliceOf(a, b, c)],
    )
    expect(lines).toContain("### From `b` (3 symbols)")
    expect(treeRows(lines)).toEqual([
      "- `b` — logic changed · `x.ts:10`",
      "  - `c` — logic changed · `x.ts:20`",
      "    - `a` — logic changed · `x.ts:1`",
      "    - `b` *(see above)*",
    ])
  })

  it.each<[string, boolean, string]>([
    ["a ring alone", false, "### From `visit` (3 symbols)"],
    ["a ring beside a member nothing calls", true, "### From `main`, `visit` (4 symbols)"],
  ])("starts from each ring no start reaches, for %s", (_, withMain, heading) => {
    const helper = symbolAt("src/v.ts", "helper", 1)
    const main = symbolAt("src/v.ts", "main", 5)
    const visit = symbolAt("src/v.ts", "visit", 10)
    const visitChildren = symbolAt("src/v.ts", "visitChildren", 20)
    const ring = [
      logicChange(helper),
      logicChange(withCallsTo(visit, [helper, 11], [visitChildren, 12])),
      logicChange(withCallsTo(visitChildren, [visit, 21])),
    ]
    const lines = withMain
      ? sliceView(
          [...ring, logicChange(withCallsTo(main, [helper, 6]))],
          [sliceOf(helper, main, visit, visitChildren)],
        )
      : sliceView(ring, [sliceOf(helper, visit, visitChildren)])
    expect(lines).toContain(heading)
    expect(treeRows(lines).slice(-4)).toEqual([
      "- `visit` — logic changed · `v.ts:10`",
      `  - \`helper\` ${withMain ? "*(see above)*" : "— logic changed · `v.ts:1`"}`,
      "  - `visitChildren` — logic changed · `v.ts:20`",
      "    - `visit` *(see above)*",
    ])
  })

  it("carries a chain too deep to indent on from a row of its own", () => {
    const members = chain("c", 8)
    expect(treeRows(sliceView(members.map(logicChange), [sliceOf(...members)]))).toEqual([
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

  it("carries on again a carried-on chain that is too deep itself", () => {
    const members = chain("c", 12)
    const rows = treeRows(sliceView(members.map(logicChange), [sliceOf(...members)]))
    expect(rows.filter((row) => row.endsWith("*(continued)*"))).toEqual([
      "- `c5` *(continued)*",
      "- `c10` *(continued)*",
    ])
    expect(rows.slice(-2)).toEqual([
      "- `c10` *(continued)*",
      "  - `c11` — logic changed · `c.ts:12`",
    ])
  })

  it("carries on each deep start's chain once, under that start's tree", () => {
    const a = chain("a", 8)
    const b = chain("b", 8).map((member) => ({
      ...member,
      source: { ...member.source, file: "src/d.ts" },
    }))
    const rows = treeRows(sliceView([...a, ...b].map(logicChange), [sliceOf(...a, ...b)]))
    expect(rows.filter((row) => !row.startsWith(" "))).toEqual([
      "- `a0` — logic changed · `c.ts:1`",
      "- `a5` *(continued)*",
      "- `b0` — logic changed · `d.ts:1`",
      "- `b5` *(continued)*",
    ])
  })

  it("writes the callees of a member at the deepest level in place when all are above", () => {
    const members = chain("c", 6)
    const last = members[5]
    const first = members[0]
    if (last === undefined || first === undefined) throw new Error("unreachable: six members")
    members[5] = withCallsTo(last, [first, 7])
    const rows = treeRows(sliceView(members.map(logicChange), [sliceOf(...members)]))
    expect(rows.slice(-2)).toEqual([
      "          - `c5` — logic changed · `c.ts:6`",
      "            - `c0` *(see above)*",
    ])
    expect(rows.join("\n")).not.toContain("*(continued)*")
  })

  it.each<[number, string]>([
    [3, "### From `s1`, `s2`, `s3` (4 symbols)"],
    [5, "### From `s1`, `s2`, `s3` and 2 more (6 symbols)"],
  ])("names up to three of the %i members it starts from", (count, heading) => {
    const hub = symbolAt("src/hub.ts", "hub", 1)
    const starts = Array.from({ length: count }, (_, i) => symbolAt("src/s.ts", `s${i + 1}`, 1))
    const lines = sliceView(
      [...starts.map((start) => logicChange(withCallsTo(start, [hub, 2]))), logicChange(hub)],
      [sliceOf(...starts, hub)],
    )
    expect(lines).toContain(heading)
  })

  it("labels each file by the fewest trailing segments that tell it apart", () => {
    const a = symbolAt("src/a/index.ts", "a", 1)
    const b = symbolAt("src/b/index.ts", "b", 2)
    const c = symbolAt("src/c.ts", "c", 3)
    const lines = sliceView(
      [logicChange(withCallsTo(a, [b, 2])), logicChange(withCallsTo(b, [c, 3])), logicChange(c)],
      [sliceOf(a, b, c)],
    )
    expect(lines).toContain("Files: `src/a/index.ts`, `src/b/index.ts`, `src/c.ts`")
    expect(treeRows(lines)).toEqual([
      "- `a` — logic changed · `a/index.ts:1`",
      "  - `b` — logic changed · `b/index.ts:2`",
      "    - `c` — logic changed · `c.ts:3`",
    ])
  })

  it("names the one file of a Slice that has one", () => {
    const a = symbolAt("src/x.ts", "a", 1)
    const b = symbolAt("src/x.ts", "b", 5)
    expect(
      sliceView([logicChange(withCallsTo(a, [b, 2])), logicChange(b)], [sliceOf(a, b)]),
    ).toContain("File: `src/x.ts`")
  })

  it("draws a call only the base made, between the members its ends became, as removed and last", () => {
    const formerRepo = symbolAt("src/old-repo.ts", "Repo.save", 3)
    const lines = sliceView(
      [
        changed(
          withCallsTo(ctl, [formerRepo, 1], [svc, 9]),
          { logicChanged: true },
          {
            calls: withCallsTo(ctl, [svc, 3]).calls,
          },
        ),
        logicChange(svc),
        movedChanged(formerRepo, repo, { logicChanged: true }),
      ],
      [sliceOf(ctl, repo, svc)],
    )
    expect(treeRows(lines)).toEqual([
      "- `Ctl.route` — logic changed · `ctl.ts:42`",
      "  - `Svc.op` — logic changed · `svc.ts:88`",
      "  - `Repo.save` *(call removed)* — moved: `src/old-repo.ts` → `src/repo.ts`; logic changed · `repo.ts:15`",
    ])
  })

  it("says a call to a member written out above was removed", () => {
    const lines = sliceView(
      [
        changed(
          withCallsTo(ctl, [repo, 1], [svc, 3]),
          { logicChanged: true },
          {
            calls: withCallsTo(ctl, [svc, 3]).calls,
          },
        ),
        logicChange(withCallsTo(svc, [repo, 5])),
        logicChange(repo),
      ],
      [sliceOf(ctl, repo, svc)],
    )
    expect(treeRows(lines)).toEqual([
      "- `Ctl.route` — logic changed · `ctl.ts:42`",
      "  - `Svc.op` — logic changed · `svc.ts:88`",
      "    - `Repo.save` — logic changed · `repo.ts:15`",
      "  - `Repo.save` *(call removed; see above)*",
    ])
  })

  it("draws the calls of a removed member as they were, as its row says it is gone", () => {
    const lines = sliceView(
      [{ status: "removed", symbol: withCallsTo(ctl, [svc, 3]) }, logicChange(svc)],
      [sliceOf(ctl, svc)],
    )
    expect(treeRows(lines)).toEqual([
      "- `Ctl.route` — removed function · `ctl.ts:42`",
      "  - `Svc.op` — logic changed · `svc.ts:88`",
    ])
  })

  it("orders a call both revisions make by its line in the head", () => {
    const lines = sliceView(
      [
        changed(
          withCallsTo(ctl, [svc, 9], [repo, 3]),
          { logicChanged: true },
          {
            calls: withCallsTo(ctl, [svc, 3], [repo, 9]).calls,
          },
        ),
        logicChange(svc),
        logicChange(repo),
      ],
      [sliceOf(ctl, repo, svc)],
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
    expect(sliceView([change, logicChange(ctl)], [sliceOf(ctl, repo)])).toContain(
      `- \`Repo.save\` — ${followUp} · \`repo.ts:15\``,
    )
  })

  it("writes Slices in the order given", () => {
    const a = symbolAt("src/a.ts", "a", 1)
    const b = symbolAt("src/b.ts", "b", 1)
    const lines = sliceView(
      [
        logicChange(svc),
        logicChange(withCallsTo(ctl, [svc, 2])),
        logicChange(withCallsTo(a, [b, 2])),
        logicChange(b),
      ],
      [sliceOf(svc, ctl), sliceOf(a, b)],
    )
    expect(lines.filter((line) => line.startsWith("### "))).toEqual([
      "### From `Ctl.route` (2 symbols)",
      "### From `a` (2 symbols)",
    ])
  })

  it("folds the singleton Slices into one block after the others, one row per member", () => {
    const solo = symbolAt("src/util.ts", "formatMoney", 3)
    const lines = sliceView(
      [logicChange(ctl), logicChange(svc), logicChange(solo), logicChange(repo)],
      [
        sliceOf(ctl, svc),
        sliceOf(solo),
        { id: sliceId("slice:ts:src/elsewhere.ts#other"), members: [repo.id] },
      ],
    )
    expect(lines.slice(lines.indexOf("### Standalone changes"))).toEqual([
      "### Standalone changes",
      "",
      "<details>",
      "<summary>2 symbols with no resolved call to or from another symbol in this view</summary>",
      "",
      "- `formatMoney` — logic changed · `src/util.ts:3`",
      "- `Repo.save` — logic changed · `src/repo.ts:15`",
      "",
      "</details>",
      "",
    ])
  })

  it("counts a single singleton in the singular", () => {
    expect(sliceView([logicChange(ctl)], [sliceOf(ctl)])).toContain(
      "<summary>1 symbol with no resolved call to or from another symbol in this view</summary>",
    )
  })

  it("writes only the fold when every Slice is a singleton", () => {
    const lines = sliceView([logicChange(ctl), logicChange(svc)], [sliceOf(ctl), sliceOf(svc)])
    expect(lines.slice(0, 4)).toEqual([HEADING, "", "### Standalone changes", ""])
  })

  it.each<[string, SliceRecord, string, string]>([
    [
      "a member that has no change in the diff",
      sliceOf(ctl, svc),
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
  function unresolvedCaller(name: string, ...targets: string[]): IRSymbol {
    return symbolAt("src/ctl.ts", name, 1, {
      calls: targets.map((target, i) => ({ target, line: 2 + i, resolved: null })),
    })
  }

  const format = symbolAt("src/format.ts", "format", 4)

  /** `caller` in a Slice with `Svc.op`, and `others` in a Slice of their own. */
  function crossing(caller: IRSymbol, ...others: IRSymbol[]): string[] {
    return sliceView(
      [logicChange(caller), logicChange(svc), ...others.map(logicChange)],
      [sliceOf(caller, svc), sliceOf(...others)],
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
    expect(crossing(unresolvedCaller("Ctl.route", ...targets), repo, format)[2]).toBe(note)
  })

  it("marks the member making such a call, naming each target once", () => {
    const lines = crossing(
      unresolvedCaller("Ctl.route", "getRepo.save", "join", "getRepo.save"),
      repo,
    )
    expect(lines).toContain(
      "- `Ctl.route` — logic changed · `ctl.ts:1` · ⚠ unresolved call to `getRepo.save`",
    )
    expect(lines).toContain("- `Svc.op` — logic changed · `svc.ts:88`")
  })

  it.each<[string, string, string, string]>([
    ["a method through a receiver named after its class", "Ctl.route", "getRepo.save", "Repo.save"],
    ["a method whose class is named after the receiver", "Ctl.route", "repo.save", "UserRepo.save"],
    [
      "a method whose class word the receiver's word begins with",
      "Ctl.route",
      "repository.save",
      "UserRepo.save",
    ],
    [
      "a method whose class word begins with the receiver's word",
      "Ctl.route",
      "users.findOne",
      "UserRepository.findOne",
    ],
    [
      "a method through a field of `this`, whatever it is called",
      "Ctl.route",
      "this.db.query",
      "Database.query",
    ],
    [
      "a method another class declares, through `this` in a method",
      "UserRepo.load",
      "this.save",
      "BaseRepo.save",
    ],
    [
      "a method another class declares, through `super`",
      "UserRepo.save",
      "super.save",
      "BaseRepo.save",
    ],
    ["a plain function by a bare call", "Ctl.route", "format", "format"],
  ])("takes a call to %s as such a call", (_, caller, target, member) => {
    expect(
      crossing(unresolvedCaller(caller, target), symbolAt("src/other.ts", member, 1)).join("\n"),
    ).toContain(`⚠ unresolved call to \`${target}\``)
  })

  it("marks a call only the base made", () => {
    const lines = sliceView(
      [
        changed(
          unresolvedCaller("Ctl.route", "getRepo.save"),
          { logicChanged: true },
          { calls: [] },
        ),
        logicChange(svc),
        logicChange(repo),
      ],
      [sliceOf(ctl, svc), sliceOf(repo)],
    )
    expect(lines.join("\n")).toContain("⚠ unresolved call to `getRepo.save`")
  })

  it("marks a singleton that makes such a call, an added one included", () => {
    const added = symbolAt("src/add.ts", "addedFn", 1, {
      calls: ["Repo.save", "Svc.op"].map((target) => ({ target, line: 2, resolved: null })),
    })
    expect(
      sliceView(
        [{ status: "added", symbol: added }, logicChange(repo), logicChange(svc)],
        [sliceOf(added), sliceOf(repo, svc)],
      ),
    ).toContain(
      "- `addedFn` — new function · `src/add.ts:1` · ⚠ unresolved calls to `Repo.save`, `Svc.op`",
    )
  })

  it.each<[string, string, string, string]>([
    ["a target no changed symbol is named after", "Ctl.route", "rows.push", "Repo.save"],
    ["a member of its own Slice", "Ctl.route", "svc.op", "Repo.save"],
    ["a target whose last segment is computed", "Ctl.route", "handlers.<computed>", "Repo.save"],
    ["a method through a receiver that names another class", "Ctl.route", "user.save", "Repo.save"],
    ["a method through a one-letter receiver", "Ctl.route", "e.save", "Repo.save"],
    [
      "a method through a receiver no name spells",
      "Ctl.route",
      "<computed>.save",
      "ComputedRepo.save",
    ],
    ["a method by a bare call", "Ctl.route", "save", "Repo.save"],
    ["a plain function through a receiver", "Ctl.route", "id.format", "format"],
    ["a method through `this` in a plain function", "handler", "this.save", "Repo.save"],
  ])("says nothing about an unresolved call to %s", (_, caller, target, member) => {
    expect(
      crossing(unresolvedCaller(caller, target), symbolAt("src/other.ts", member, 1)).join("\n"),
    ).not.toContain("⚠")
  })
})
