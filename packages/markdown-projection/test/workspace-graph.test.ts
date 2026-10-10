import { component, dependency, makeIR } from "@aburi/test-support"
import type { Dependency } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { MERMAID_NODE_LIMIT, projectWorkspace } from "../src"
import { sectionOf } from "./markdown"

const HEADING = "## Component dependencies"
const billing = component({ id: "billing", name: "Billing" })
const payments = component({ id: "payments", name: "Payments" })
const symbolEdge = dependency({
  from: "ts:src/a.ts#caller",
  to: "ts:src/util.ts#helper",
  via: "call",
})

const numbered = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    component({ id: `c-${String(i).padStart(3, "0")}`, name: `C${i}` }),
  )

describe("projectWorkspace — component dependency graph", () => {
  it("draws components as nodes and their edges as arrows, then lists the edges", () => {
    const md = projectWorkspace(
      makeIR({
        components: [payments, billing],
        dependencies: [dependency({ from: "billing", to: "payments", via: "import" }), symbolEdge],
      }),
    )
    expect(sectionOf(md, HEADING)).toEqual([
      HEADING,
      "",
      "```mermaid",
      "graph LR",
      '  billing["Billing"]',
      '  payments["Payments"]',
      "  billing --> payments",
      "```",
      "",
      "Fallback list:",
      "",
      "- billing → payments (via `import`)",
      "",
    ])
  })

  it.each<[string, Dependency[]]>([
    ["no edge at all", []],
    ["only a Symbol edge", [symbolEdge]],
  ])("draws a lone component as a node, with no list, given %s", (_, dependencies) => {
    expect(
      sectionOf(projectWorkspace(makeIR({ components: [billing], dependencies })), HEADING),
    ).toEqual([HEADING, "", "```mermaid", "graph LR", '  billing["Billing"]', "```", ""])
  })

  it("draws one arrow for two edges between the same pair, and lists both", () => {
    const md = projectWorkspace(
      makeIR({
        components: [billing, payments],
        dependencies: [
          dependency({ from: "billing", to: "payments", via: "import" }),
          dependency({ from: "billing", to: "payments", via: "event" }),
        ],
      }),
    )
    const section = sectionOf(md, HEADING)
    expect(section.filter((line) => line.includes("-->"))).toEqual(["  billing --> payments"])
    expect(section).toContain("- billing → payments (via `event`)")
    expect(section).toContain("- billing → payments (via `import`)")
  })

  it("draws an edge to an endpoint no component declares, without declaring it", () => {
    const md = projectWorkspace(
      makeIR({
        components: [billing],
        dependencies: [dependency({ from: "billing", to: "stray" })],
      }),
    )
    expect(md).toContain("  billing --> stray")
    expect(md).toContain("- billing → stray (via `import`)")
    expect(md).not.toContain('stray["')
  })

  it("says there is nothing to draw for a workspace with no component and no edge", () => {
    expect(sectionOf(projectWorkspace(makeIR()), HEADING)).toEqual([
      HEADING,
      "",
      "_No inter-component dependencies._",
      "",
    ])
  })

  it("maps distinct component ids to distinct node ids", () => {
    const ids = ["billing", "billing-api", "billing-api-v2", "a", "ab-c", "abc"]
    const md = projectWorkspace(
      makeIR({ components: ids.map((id) => component({ id, name: id })) }),
    )
    const nodeIds = new Set(
      md.split("\n").flatMap((line) => line.match(/^\s+([a-z0-9_]+)\["/)?.slice(1) ?? []),
    )
    expect(nodeIds.size).toBe(ids.length)
  })

  it("escapes the characters that would break a node label", () => {
    const md = projectWorkspace(
      makeIR({ components: [component({ id: "foo", name: 'A "b" & <c> [d]\nnext' })] }),
    )
    expect(md).toContain('  foo["A &quot;b&quot; &amp; &lt;c&gt; [d&rbrack;<br/>next"]\n')
  })
})

describe("projectWorkspace — component dependency graph size limit", () => {
  it(`draws the graph at ${MERMAID_NODE_LIMIT} nodes`, () => {
    const md = projectWorkspace(makeIR({ components: numbered(MERMAID_NODE_LIMIT) }))
    expect(md).toContain("```mermaid\ngraph LR\n")
    expect(md).not.toContain("_Component graph omitted:")
  })

  it("replaces a graph past the limit with a note, counting edge endpoints as nodes", () => {
    const md = projectWorkspace(
      makeIR({
        components: numbered(MERMAID_NODE_LIMIT),
        dependencies: [dependency({ from: "c-000", to: "outside" })],
      }),
    )
    expect(md).not.toContain("```mermaid")
    expect(md).toContain(
      `_Component graph omitted: ${MERMAID_NODE_LIMIT + 1} nodes exceeds the render limit (${MERMAID_NODE_LIMIT}). See list below._`,
    )
    expect(md).toContain("Fallback list:\n\n- c-000 → outside (via `import`)\n")
  })
})
