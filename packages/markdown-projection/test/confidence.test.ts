import { component, effect, makeSymbol } from "@aburi/test-support"
import type { Confidence, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { effectRow, projectComponent, projectSymbolExplain } from "../src"
import { changed, movedChanged, projectChanges, relocated } from "./fixtures"
import { bytes } from "./markdown"

const controller = (confidence: Confidence, i = 0): IRSymbol =>
  makeSymbol({
    id: `ts:src/x.controller.ts#XController${i}`,
    name: `XController${i}`,
    kind: "class",
    confidence,
  })

const views: [string, (symbol: IRSymbol) => string, (title: string) => string][] = [
  [
    "component page heading",
    (symbol) =>
      projectComponent({
        component: component({ id: "core", name: "core" }),
        symbols: [symbol],
        dependencies: [],
      }),
    (title) => `#### ${title}`,
  ],
  [
    "diff.md entry heading",
    (symbol) => projectChanges([{ status: "added", symbol }]),
    (title) => `### ${title}`,
  ],
  [
    "diff.md names-only row",
    (symbol) => {
      const added = [symbol, ...Array.from({ length: 19 }, (_, i) => controller("high", i + 1))]
      const changes = added.map((entry) => ({ status: "added" as const, symbol: entry }))
      return projectChanges(changes, { maxBytes: bytes(projectChanges(changes)) - 1 })
    },
    (title) => `- ${title} — \`src/x.controller.ts:1\``,
  ],
  ["explain title", (symbol) => projectSymbolExplain(symbol), (title) => `# ${title}`],
  [
    "dropped explain title",
    (symbol) => projectSymbolExplain({ ...symbol, dropped: true, dropReason: "pure DTO" }),
    (title) => `# ${title} — dropped`,
  ],
]

describe("a Symbol's confidence on every line that names it", () => {
  it.each(views)("badges a medium Symbol on the %s", (_, render, line) => {
    expect(render(controller("medium")).split("\n")).toContain(
      line("`XController0` *(class)* ⚠ medium"),
    )
  })

  it.each(views)("draws nothing for a high Symbol on the %s", (_, render, line) => {
    expect(render(controller("high")).split("\n")).toContain(line("`XController0` *(class)*"))
  })

  it("spells a low Symbol's badge with its own word", () => {
    expect(projectSymbolExplain(controller("low")).split("\n")[0]).toBe(
      "# `XController0` *(class)* ⚠ low",
    )
  })
})

describe("an Effect row's confidence", () => {
  it("badges a medium Effect after its plugin", () => {
    expect(
      effectRow(
        effect({
          id: "event.publish",
          target: "bus.emit",
          plugin: "effects-nest",
          confidence: "medium",
        }),
      ),
    ).toBe("- event.publish: `bus.emit` (L1) [effects-nest] ⚠ medium")
  })

  it("draws nothing for a high Effect", () => {
    expect(
      effectRow(
        effect({ id: "db.read", target: "prisma.user.findMany", plugin: "effects-prisma" }),
      ),
    ).toBe("- db.read: `prisma.user.findMany` (L1) [effects-prisma]")
  })
})

describe("diff.md reports a confidence change", () => {
  const sure = controller("high")

  it("gives a confidence-only change its own section, with before and after", () => {
    const md = projectChanges([
      changed(sure, { confidenceChanged: true }, { confidence: "medium" }),
    ])

    expect(md).toContain(
      "## 🎚 Confidence changes\n\n### `XController0` *(class)* ⚠ medium\n**File**: `src/x.controller.ts:1`\n\n- confidence: `high` → `medium`\n",
    )
  })

  it("shows the row, and no badge, when the machine became sure", () => {
    const md = projectChanges([
      changed(controller("medium"), { confidenceChanged: true }, { confidence: "high" }),
    ])

    expect(md).toContain("### `XController0` *(class)*\n")
    expect(md).toContain("- confidence: `medium` → `high`")
  })

  it("lists a moved Symbol whose only change is confidence under both of its sections", () => {
    const after = { ...relocated(sure, "src/moved/x.controller.ts"), confidence: "medium" as const }
    const md = projectChanges([movedChanged(sure, after, { confidenceChanged: true }, "id-match")])

    for (const heading of ["## 🔀 Moved + Changed", "## 🎚 Confidence changes"]) {
      const section = md.slice(md.indexOf(heading))
      expect(section).toContain("### `XController0` *(class)* ⚠ medium")
      expect(section).toContain("- confidence: `high` → `medium`")
    }
  })

  it("says nothing about confidence for a diff written before the field existed", () => {
    const md = projectChanges([changed(sure, { logicChanged: true })])

    expect(md.toLowerCase()).not.toContain("confidence")
    expect(md).toContain("## 🔧 Logic changes")
  })
})
