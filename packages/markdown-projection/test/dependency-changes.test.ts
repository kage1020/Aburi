import { dependency, makeDiff } from "@aburi/test-support"
import type { Dependency, DependencyUnknown } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { sectionOf } from "./markdown"

const HEADING = "## 🔗 Dependency changes"

const callEdge = (from: string, to: string): Dependency =>
  dependency({ from: `ts:src/${from}.ts#${from}`, to: `ts:src/${to}.ts#${to}`, via: "call" })

function changes(
  added: Dependency[],
  removed: Dependency[] = [],
  unknown?: DependencyUnknown[],
): string[] {
  return sectionOf(
    projectDiff(
      makeDiff({ dependencies: { added, removed, ...(unknown === undefined ? {} : { unknown }) } }),
    ),
    HEADING,
  )
}

describe("projectDiff — Dependency changes", () => {
  it("groups component edges apart from edges with a Symbol at either end", () => {
    expect(
      changes(
        [
          callEdge("caller", "helper"),
          dependency({ from: "billing", to: "payments" }),
          dependency({ from: "billing", to: "ts:src/util.ts#format" }),
        ],
        [dependency({ from: "old", to: "gone" })],
      ),
    ).toEqual([
      HEADING,
      "",
      "### Component-level added",
      "- `billing` → `payments` (via `import`)",
      "",
      "### Component-level removed",
      "- `old` → `gone` (via `import`)",
      "",
      "### Symbol-level added",
      "- `caller` in `src/caller.ts` → `helper` in `src/helper.ts` (via `call`)",
      "- `billing` → `format` in `src/util.ts` (via `import`)",
      "",
    ])
  })

  it("names the file once for an edge between two Symbols of one file", () => {
    expect(
      changes([
        dependency({
          from: "ts:src/walk.ts#Walker.visit",
          to: "ts:src/walk.ts#exitsFrom",
          via: "call",
        }),
      ]),
    ).toContain("- `Walker.visit` → `exitsFrom` in `src/walk.ts` (via `call`)")
  })

  it("omits the section when nothing changed at any level", () => {
    expect(projectDiff(makeDiff())).not.toContain(HEADING)
  })
})

describe("projectDiff — the Unknown dependency group", () => {
  const lostEdge = callEdge("handleRequest", "log")

  it("names the edge, the side that lost the file, and why, after every group a reviewer reads as a change", () => {
    expect(
      changes(
        [dependency({ from: "billing", to: "payments" })],
        [callEdge("caller", "callee")],
        [
          {
            dependency: lostEdge,
            absentFrom: "head",
            lostFiles: [{ path: "src/handleRequest.ts", reason: "parse-failed" }],
          },
        ],
      ),
    ).toEqual([
      HEADING,
      "",
      "### Component-level added",
      "- `billing` → `payments` (via `import`)",
      "",
      "### Symbol-level removed",
      "- `caller` in `src/caller.ts` → `callee` in `src/callee.ts` (via `call`)",
      "",
      "### Unknown — the other revision never read one end",
      "- `handleRequest` in `src/handleRequest.ts` → `log` in `src/log.ts` (via `call`) — " +
        "the head scan skipped `src/handleRequest.ts` (parse-failed)",
      "",
    ])
  })

  it("names both files when the two endpoints went for different reasons", () => {
    const lines = changes(
      [],
      [],
      [
        {
          dependency: lostEdge,
          absentFrom: "base",
          lostFiles: [
            { path: "src/handleRequest.ts", reason: "parse-timeout" },
            { path: "src/log.ts", reason: "over-size" },
          ],
        },
      ],
    )
    expect(lines.at(-2)).toMatch(
      / — the base scan skipped `src\/handleRequest\.ts` \(parse-timeout\), `src\/log\.ts` \(over-size\)$/,
    )
  })

  it.each<[string, DependencyUnknown[] | undefined]>([
    ["nothing is unknown", []],
    ["the diff predates the field", undefined],
  ])("is left out when %s", (_, unknown) => {
    const md = projectDiff(
      makeDiff({
        dependencies: {
          added: [dependency({ from: "a", to: "b" })],
          removed: [],
          ...(unknown === undefined ? {} : { unknown }),
        },
      }),
    )
    expect(md).not.toContain("never read one end")
  })
})
