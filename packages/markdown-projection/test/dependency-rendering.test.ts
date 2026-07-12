import { describe, expect, it } from "vitest"
import { projectComponent, projectDiff, projectSymbolExplain, projectWorkspace } from "../src"
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
    expect(md).toContain("billing --> payments")
    expect(md).toContain("- billing → payments (via `import`)")
  })

  it("excludes symbol-to-symbol edges from the workspace-level mermaid graph", () => {
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
    // No inter-component edges means the whole section collapses to the empty
    // note, not a graph containing symbol ids.
    expect(md).toContain("_No inter-component dependencies._")
    expect(md).not.toContain("graph LR")
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
