import { describe, expect, it } from "vitest"
import { type DependencySideView, diffComponents, diffDependencies } from "../src"
import { component, dependency } from "./fixtures"

/**
 * Side views for two documents that skipped nothing. Every one of these tests is about
 * identity comparison, not about loss, so the honest input is a pair that has no skip list to
 * offer — which `diffDependencies` requires a caller to spell rather than default into.
 */
const NO_LOSSES: { base: DependencySideView; head: DependencySideView } = {
  base: { symbolFiles: new Map(), lostFiles: new Map() },
  head: { symbolFiles: new Map(), lostFiles: new Map() },
}

describe("diffComponents (I5)", () => {
  it("classifies unchanged components as no-op (not in added/removed/changed)", () => {
    const c = component({ id: "billing", name: "billing" })
    const result = diffComponents([c], [c])
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.changed).toEqual([])
  })

  it("lists a removed component", () => {
    const c = component({ id: "billing", name: "billing" })
    const result = diffComponents([c], [])
    expect(result.removed).toHaveLength(1)
    expect(result.removed[0]?.id).toBe("billing")
  })

  it("sets rootsChanged=true when roots reshuffle", () => {
    const before = component({ id: "billing", name: "billing", roots: ["apps/billing"] })
    const after = component({
      id: "billing",
      name: "billing",
      roots: ["apps/billing", "packages/billing-domain"],
    })
    const result = diffComponents([before], [after])
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]?.delta).toEqual({
      rootsChanged: true,
      publicApiChanged: false,
      frameworksChanged: false,
    })
  })

  it("sets publicApiChanged=true when publicApi globs differ", () => {
    const before = component({
      id: "billing",
      name: "billing",
      publicApi: ["apps/billing/routes/**"],
    })
    const after = component({
      id: "billing",
      name: "billing",
      publicApi: ["apps/billing/routes/**", "apps/billing/api/**"],
    })
    const result = diffComponents([before], [after])
    expect(result.changed[0]?.delta.publicApiChanged).toBe(true)
    expect(result.changed[0]?.delta.rootsChanged).toBe(false)
  })

  it("sets frameworksChanged=true when framework hint list differs", () => {
    const before = component({ id: "billing", name: "billing", frameworks: [] })
    const after = component({
      id: "billing",
      name: "billing",
      frameworks: ["nestjs"],
    })
    const result = diffComponents([before], [after])
    expect(result.changed[0]?.delta.frameworksChanged).toBe(true)
  })

  it("does not emit changed[] entries when all three axes are stable", () => {
    const before = component({ id: "billing", name: "billing", frameworks: [] })
    // Same id, same everything → not in changed[].
    const result = diffComponents([before], [before])
    expect(result.changed).toEqual([])
  })
})

describe("diffDependencies (I5)", () => {
  it("emits added + removed as a pair when direction changes on the same triple", () => {
    const before = dependency({
      from: "billing",
      to: "payments",
      via: "import",
      direction: "outbound",
    })
    const after = dependency({
      from: "billing",
      to: "payments",
      via: "import",
      direction: "inbound",
    })
    const result = diffDependencies([before], [after], NO_LOSSES)
    expect(result.added).toHaveLength(1)
    expect(result.removed).toHaveLength(1)
    expect(result.added[0]?.direction).toBe("inbound")
    expect(result.removed[0]?.direction).toBe("outbound")
  })

  it("emits added + removed when effect changes but (from, to, via) is stable", () => {
    const before = dependency({
      from: "billing",
      to: "payments",
      via: "call",
      effect: null,
    })
    const after = dependency({
      from: "billing",
      to: "payments",
      via: "call",
      effect: "db.write",
    })
    const result = diffDependencies([before], [after], NO_LOSSES)
    expect(result.added).toHaveLength(1)
    expect(result.removed).toHaveLength(1)
  })

  it("emits pure removed when the triple vanishes from head", () => {
    const before = dependency({ from: "a", to: "b" })
    const result = diffDependencies([before], [], NO_LOSSES)
    expect(result.removed).toHaveLength(1)
    expect(result.added).toEqual([])
  })

  it("emits pure added when the triple is new in head", () => {
    const after = dependency({ from: "a", to: "b" })
    const result = diffDependencies([], [after], NO_LOSSES)
    expect(result.added).toHaveLength(1)
    expect(result.removed).toEqual([])
  })

  it("sorts added / removed deterministically by composite key", () => {
    const result = diffDependencies(
      [],
      [
        dependency({ from: "z", to: "a" }),
        dependency({ from: "a", to: "z" }),
        dependency({ from: "a", to: "b" }),
      ],
      NO_LOSSES,
    )
    const keys = result.added.map((d) => `${d.from}::${d.to}::${d.via}`)
    expect(keys).toEqual([...keys].sort())
  })

  it("treats a symbol-id endpoint added in head as a plain add on the same (from, to, via) key", () => {
    const after = dependency({
      from: "ts:src/a.ts#caller",
      to: "ts:src/util.ts#helper",
      via: "call",
      direction: "outbound",
      effect: null,
    })
    const result = diffDependencies([], [after], NO_LOSSES)
    expect(result.added).toHaveLength(1)
    expect(result.added[0]?.from).toBe("ts:src/a.ts#caller")
    expect(result.added[0]?.via).toBe("call")
  })

  it("mixes component-level and symbol-level edges in one added[] and sorts them together", () => {
    const compEdge = dependency({
      from: "billing",
      to: "payments",
      via: "import",
    })
    const symEdge = dependency({
      from: "ts:src/a.ts#caller",
      to: "ts:src/util.ts#helper",
      via: "call",
      direction: "outbound",
      effect: null,
    })
    const result = diffDependencies([], [symEdge, compEdge], NO_LOSSES)
    expect(result.added).toHaveLength(2)
    const keys = result.added.map((d) => `${d.from}::${d.to}::${d.via}`)
    expect(keys).toEqual([...keys].sort())
    // The composite-key sort places the component-level "billing::payments::import"
    // before the symbol-id "ts:src/..." endpoints because lowercase kebab-case
    // component ids sort ahead of the language-prefixed symbol ids.
    expect(result.added[0]?.from).toBe("billing")
    expect(result.added[1]?.from).toBe("ts:src/a.ts#caller")
  })

  it("emits pure removed when a symbol-level edge disappears from head", () => {
    const before = dependency({
      from: "ts:src/a.ts#caller",
      to: "ts:src/util.ts#helper",
      via: "call",
      direction: "outbound",
      effect: null,
    })
    const result = diffDependencies([before], [], NO_LOSSES)
    expect(result.removed).toHaveLength(1)
    expect(result.added).toEqual([])
  })
})
