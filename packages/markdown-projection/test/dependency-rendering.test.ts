import { describe, expect, it } from "vitest"
import {
  MERMAID_NODE_LIMIT,
  projectComponent,
  projectDiff,
  projectSymbolExplain,
  projectWorkspace,
} from "../src"
import { component, dependency, makeDiff, makeIR, makeSymbol } from "./fixtures"

describe("workspace mermaid dependencies (symbol-edge exclusion)", () => {
  it("emits component-level dependencies into the mermaid graph", () => {
    const ir = makeIR({
      components: [
        component({ id: "billing", name: "Billing" }),
        component({ id: "payments", name: "Payments" }),
      ],
      dependencies: [dependency({ from: "billing", to: "payments", via: "import" })],
    })
    const md = projectWorkspace(ir)
    expect(md).toContain("graph LR")
    expect(md).toContain('billing["Billing"]')
    expect(md).toContain('payments["Payments"]')
    expect(md).toContain("billing --> payments")
    expect(md).toContain("- billing → payments (via `import`)")
  })

  it("renders an isolated component as a mermaid node when only symbol edges exist", () => {
    const ir = makeIR({
      components: [component({ id: "billing", name: "Billing" })],
      dependencies: [
        dependency({
          from: "ts:src/a.ts#caller",
          to: "ts:src/util.ts#helper",
          via: "call",
          direction: "outbound",
          effect: null,
        }),
      ],
    })
    const md = projectWorkspace(ir)
    // The symbol-only edge is excluded from the workspace mermaid, but the declared
    // component still appears as a standalone node (isolated components must not
    // disappear from the L0 monorepo view).
    expect(md).toContain("graph LR")
    expect(md).toContain('billing["Billing"]')
    expect(md).not.toContain("Fallback list:")
    expect(md).not.toContain("_No inter-component dependencies._")
    expect(md).not.toContain("ts:src/a.ts#caller")
  })

  it("does not fold a symbol edge into the fallback list either", () => {
    const ir = makeIR({
      components: [
        component({ id: "billing", name: "Billing" }),
        component({ id: "payments", name: "Payments" }),
      ],
      dependencies: [
        dependency({ from: "billing", to: "payments", via: "import" }),
        dependency({
          from: "ts:src/a.ts#caller",
          to: "ts:src/util.ts#helper",
          via: "call",
          direction: "outbound",
          effect: null,
        }),
      ],
    })
    const md = projectWorkspace(ir)
    // Component edge survives; symbol edge is dropped from both the graph and the fallback list.
    expect(md).toContain("- billing → payments (via `import`)")
    expect(md).not.toContain("ts:src/a.ts#caller")
    expect(md).not.toContain("ts:src/util.ts#helper")
  })
})

describe("workspace mermaid graph — all-component enumeration", () => {
  it("renders a lone component with no edges as a mermaid node (no fallback list)", () => {
    const ir = makeIR({
      components: [component({ id: "billing", name: "Billing" })],
      dependencies: [],
    })
    const md = projectWorkspace(ir)
    expect(md).toContain("graph LR")
    expect(md).toContain('billing["Billing"]')
    expect(md).not.toContain("-->")
    expect(md).not.toContain("Fallback list:")
    expect(md).not.toContain("_No inter-component dependencies._")
  })

  it("orders component node declarations ascending by id, regardless of insertion order", () => {
    const ir = makeIR({
      components: [
        component({ id: "zed", name: "Zed" }),
        component({ id: "alpha", name: "Alpha" }),
        component({ id: "middle", name: "Middle" }),
      ],
    })
    const md = projectWorkspace(ir)
    const alphaIndex = md.indexOf('alpha["Alpha"]')
    const middleIndex = md.indexOf('middle["Middle"]')
    const zedIndex = md.indexOf('zed["Zed"]')
    expect(alphaIndex).toBeGreaterThan(-1)
    expect(middleIndex).toBeGreaterThan(alphaIndex)
    expect(zedIndex).toBeGreaterThan(middleIndex)
  })

  it("sanitizes distinct ComponentId inputs to distinct mermaid node ids (injectivity)", () => {
    // If ir-schema §11 ever admits `_` in ComponentId, this test breaks first — the
    // sanitizer's `- → _` mapping would stop being injective and node lines would
    // collide silently in the rendered graph.
    const ids = ["billing", "billing-api", "billing-api-v2", "a", "ab-c", "abc"]
    const ir = makeIR({
      components: ids.map((id) => component({ id, name: id })),
    })
    const md = projectWorkspace(ir)
    const nodeIds = new Set<string>()
    for (const line of md.split("\n")) {
      const match = line.match(/^\s+([a-z0-9_]+)\["/)
      if (match !== null && match[1] !== undefined) nodeIds.add(match[1])
    }
    expect(nodeIds.size).toBe(ids.length)
  })

  it("degenerates cleanly when the IR has zero components and zero dependencies", () => {
    const ir = makeIR({ components: [], dependencies: [] })
    const md = projectWorkspace(ir)
    expect(md).toContain("_No inter-component dependencies._")
    expect(md).not.toContain("graph LR")
    expect(md).not.toContain("```mermaid")
  })

  it("escapes mermaid-hostile characters in component names so the label syntax stays valid", () => {
    // Each character below would silently break the graph render if it slipped
    // through raw: `"` closes the label, `]` closes the node, `<`/`>` break
    // out into raw HTML, `\n` splits the mermaid statement, and `&` in raw
    // form would corrupt any subsequent HTML entity.
    const ir = makeIR({
      components: [component({ id: "foo", name: 'A "b" & <c> [d]\nnext' })],
    })
    const md = projectWorkspace(ir)
    expect(md).toContain('foo["A &quot;b&quot; &amp; &lt;c&gt; [d&rbrack;<br/>next"]')
    for (const line of md.split("\n")) {
      if (line.trimStart().startsWith("foo[")) {
        expect(line).not.toContain('"b"')
        expect(line).not.toContain("<c>")
      }
    }
  })

  it("keeps the mermaid block when the union count is exactly at the cap", () => {
    const components = Array.from({ length: MERMAID_NODE_LIMIT }, (_, i) =>
      component({ id: `c-${String(i).padStart(3, "0")}`, name: `C${i}` }),
    )
    const md = projectWorkspace(makeIR({ components }))
    expect(md).toContain("```mermaid")
    expect(md).toContain("graph LR")
    expect(md).not.toContain("_Component graph omitted:")
  })

  it("drops the mermaid block with an explicit note when the union count exceeds the cap", () => {
    const components = Array.from({ length: MERMAID_NODE_LIMIT + 1 }, (_, i) =>
      component({ id: `c-${String(i).padStart(3, "0")}`, name: `C${i}` }),
    )
    const md = projectWorkspace(makeIR({ components }))
    expect(md).not.toContain("```mermaid")
    expect(md).not.toContain("graph LR")
    expect(md).toContain(
      `_Component graph omitted: ${MERMAID_NODE_LIMIT + 1} nodes exceeds the render limit (${MERMAID_NODE_LIMIT}). See list below._`,
    )
  })

  it("keeps the Fallback list header when the mermaid block is dropped due to the cap", () => {
    // 60 components + 60 edges to non-declared endpoints → 120 union nodes
    // (well above the cap) while producing a non-empty component-edge list.
    // The reviewer still needs the bullet list AND the label that marks it.
    const components = Array.from({ length: 60 }, (_, i) =>
      component({ id: `c-${String(i).padStart(3, "0")}`, name: `C${i}` }),
    )
    const dependencies = Array.from({ length: 60 }, (_, i) =>
      dependency({
        from: `c-${String(i).padStart(3, "0")}`,
        to: `x-${String(i).padStart(3, "0")}`,
      }),
    )
    const md = projectWorkspace(makeIR({ components, dependencies }))
    expect(md).not.toContain("```mermaid")
    expect(md).toContain("_Component graph omitted:")
    expect(md).toContain("Fallback list:")
    expect(md).toContain("- c-000 → x-000 (via `import`)")
  })

  it("counts a stray edge endpoint (not declared in ir.components) toward the union gate", () => {
    // `stray` never appears in `ir.components` but is a `to` endpoint. The
    // mermaid graph must still emit the edge (readers need to see the arrow
    // land somewhere) and the union gate must count `stray` as a node.
    const ir = makeIR({
      components: [component({ id: "billing", name: "Billing" })],
      dependencies: [dependency({ from: "billing", to: "stray" })],
    })
    const md = projectWorkspace(ir)
    expect(md).toContain("graph LR")
    expect(md).toContain('billing["Billing"]')
    expect(md).toContain("billing --> stray")
    expect(md).toContain("- billing → stray (via `import`)")
    // `stray` has no `Component.name` so it has no label declaration line —
    // mermaid still renders it as a bare-id node.
    expect(md).not.toContain('stray["')
  })
})

describe("component page dependencies (symbol edge sub-section)", () => {
  it("keeps component-level edges in the flat list and lifts symbol edges into ### Symbol edges", () => {
    const billing = component({ id: "billing", name: "Billing" })
    const caller = makeSymbol({
      id: "ts:src/billing/caller.ts#caller",
      name: "caller",
      component: "billing",
    })
    const md = projectComponent({
      component: billing,
      symbols: [caller],
      dependencies: [
        dependency({ from: "billing", to: "payments", via: "import" }),
        dependency({
          from: "ts:src/billing/caller.ts#caller",
          to: "ts:src/util.ts#helper",
          via: "call",
          direction: "outbound",
          effect: null,
        }),
      ],
    })
    expect(md).toContain("## Dependencies")
    expect(md).toContain("- billing → payments (via `import`)")
    expect(md).toContain("### Symbol edges")
    expect(md).toContain(
      "- `ts:src/billing/caller.ts#caller` → `ts:src/util.ts#helper` (via `call`)",
    )
  })

  it("omits the ### Symbol edges sub-section when none of the symbols in this component participate", () => {
    const billing = component({ id: "billing", name: "Billing" })
    const foo = makeSymbol({
      id: "ts:src/billing/foo.ts#foo",
      name: "foo",
      component: "billing",
    })
    const md = projectComponent({
      component: billing,
      symbols: [foo],
      dependencies: [dependency({ from: "billing", to: "payments", via: "import" })],
    })
    expect(md).toContain("- billing → payments (via `import`)")
    expect(md).not.toContain("### Symbol edges")
  })
})

describe("diff Dependency changes section (component vs symbol partition)", () => {
  it("routes symbol edges into ### Symbol-level and component edges into ### Component-level", () => {
    const diff = makeDiff({
      dependencies: {
        added: [
          dependency({
            from: "ts:src/a.ts#caller",
            to: "ts:src/util.ts#helper",
            via: "call",
            direction: "outbound",
            effect: null,
          }),
          dependency({ from: "billing", to: "payments", via: "import" }),
        ],
        removed: [dependency({ from: "old", to: "gone", via: "import" })],
      },
    })
    const md = projectDiff(diff)
    expect(md).toContain("## 🔗 Dependency changes")
    expect(md).toContain("### Component-level added")
    expect(md).toContain("- `billing` → `payments` (via `import`)")
    expect(md).toContain("### Component-level removed")
    expect(md).toContain("- `old` → `gone` (via `import`)")
    expect(md).toContain("### Symbol-level added")
    expect(md).toContain("- `ts:src/a.ts#caller` → `ts:src/util.ts#helper` (via `call`)")
    expect(md).not.toContain("### Symbol-level removed")
  })

  it("omits the whole ## 🔗 Dependency changes section when nothing changed at any level", () => {
    const diff = makeDiff({ dependencies: { added: [], removed: [] } })
    const md = projectDiff(diff)
    expect(md).not.toContain("## 🔗 Dependency changes")
  })
})

describe("projectSymbolExplain — ## Called by section", () => {
  it("lists every caller (deduplicated, lex-sorted) when a matching via:call edge exists", () => {
    const helper = makeSymbol({
      id: "ts:src/util.ts#helper",
      name: "helper",
    })
    const md = projectSymbolExplain(helper, {
      dependencies: [
        dependency({
          from: "ts:src/z.ts#z",
          to: "ts:src/util.ts#helper",
          via: "call",
          direction: "outbound",
          effect: null,
        }),
        dependency({
          from: "ts:src/a.ts#a",
          to: "ts:src/util.ts#helper",
          via: "call",
          direction: "outbound",
          effect: null,
        }),
        // Not a call edge → ignored.
        dependency({ from: "billing", to: "payments", via: "import" }),
      ],
    })
    expect(md).toContain("## Called by")
    // Lex-sorted: 'ts:src/a.ts#a' precedes 'ts:src/z.ts#z'.
    const aIndex = md.indexOf("- `ts:src/a.ts#a`")
    const zIndex = md.indexOf("- `ts:src/z.ts#z`")
    expect(aIndex).toBeGreaterThan(-1)
    expect(zIndex).toBeGreaterThan(aIndex)
  })

  it("omits ## Called by when no via:call edge targets this Symbol", () => {
    const orphan = makeSymbol({
      id: "ts:src/util.ts#orphan",
      name: "orphan",
    })
    const md = projectSymbolExplain(orphan, { dependencies: [] })
    expect(md).not.toContain("## Called by")
  })

  it("keeps the single-argument call-site backwards compatible (no context, no section)", () => {
    const helper = makeSymbol({
      id: "ts:src/util.ts#helper",
      name: "helper",
    })
    const md = projectSymbolExplain(helper)
    expect(md).not.toContain("## Called by")
  })
})
