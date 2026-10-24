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
      '  c_billing["Billing"]',
      '  c_payments["Payments"]',
      "  c_billing --> c_payments",
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
  ])("draws a lone component as a node, then a list saying there is no component edge, given %s", (_, dependencies) => {
    expect(
      sectionOf(projectWorkspace(makeIR({ components: [billing], dependencies })), HEADING),
    ).toEqual([
      HEADING,
      "",
      "```mermaid",
      "graph LR",
      '  c_billing["Billing"]',
      "```",
      "",
      "Fallback list:",
      "",
      "_No Component edges recorded._",
      "",
    ])
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
    expect(section.filter((line) => line.includes("-->"))).toEqual(["  c_billing --> c_payments"])
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
    expect(md).toContain("  c_billing --> c_stray")
    expect(md).toContain("- billing → stray (via `import`)")
    expect(md).not.toContain('stray["')
  })

  it("says there is nothing to draw for a workspace with no component and no component edge", () => {
    expect(sectionOf(projectWorkspace(makeIR()), HEADING)).toEqual([
      HEADING,
      "",
      "_No Component edges recorded._",
      "",
    ])
  })

  it("writes each component id behind the prefix with - as _, so distinct ids stay distinct", () => {
    const ids = ["billing", "billing-api", "billing-api-v2", "a", "ab-c", "abc"]
    const md = projectWorkspace(
      makeIR({ components: ids.map((id) => component({ id, name: id })) }),
    )
    expect(md.split("\n").filter((line) => line.includes('["'))).toEqual([
      '  c_a["a"]',
      '  c_ab_c["ab-c"]',
      '  c_abc["abc"]',
      '  c_billing["billing"]',
      '  c_billing_api["billing-api"]',
      '  c_billing_api_v2["billing-api-v2"]',
    ])
  })

  it("escapes the characters that would break a node label", () => {
    const md = projectWorkspace(
      makeIR({ components: [component({ id: "foo", name: 'A "b" & <c> [d]\nnext' })] }),
    )
    expect(md).toContain('  c_foo["A &quot;b&quot; &amp; &lt;c&gt; [d&rbrack;<br/>next"]\n')
  })
})

describe("projectWorkspace — component ids that are mermaid keywords", () => {
  const api = component({ id: "api", name: "API" })
  const keywords = [
    "graph",
    "flowchart",
    "subgraph",
    "end",
    "style",
    "class",
    "interpolate",
    "click",
    "call",
    "href",
  ]

  it.each<[string, string, Dependency[], string[]]>(
    keywords.flatMap((id) => [
      [id, "with no edge", [], []],
      [
        id,
        "at the start of an edge",
        [dependency({ from: id, to: "api" })],
        [`  c_${id} --> c_api`],
      ],
      [id, "at the end of an edge", [dependency({ from: "api", to: id })], [`  c_api --> c_${id}`]],
    ]),
  )("writes the component %s under a prefixed node id, %s", (id, _, dependencies, arrows) => {
    const section = sectionOf(
      projectWorkspace(makeIR({ components: [api, component({ id, name: id })], dependencies })),
      HEADING,
    )
    expect(section.slice(section.indexOf("```mermaid"), section.indexOf("```") + 1)).toEqual([
      "```mermaid",
      "graph LR",
      '  c_api["API"]',
      `  c_${id}["${id}"]`,
      ...arrows,
      "```",
    ])
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

  it("follows the note past the limit with a list saying there is no component edge", () => {
    const md = projectWorkspace(makeIR({ components: numbered(MERMAID_NODE_LIMIT + 1) }))
    expect(sectionOf(md, HEADING)).toEqual([
      HEADING,
      "",
      `_Component graph omitted: ${MERMAID_NODE_LIMIT + 1} nodes exceeds the render limit (${MERMAID_NODE_LIMIT}). See list below._`,
      "",
      "Fallback list:",
      "",
      "_No Component edges recorded._",
      "",
    ])
  })
})
