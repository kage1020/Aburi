import { makeLanguageId } from "@aburi/core"
import type { Component } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { type DependencySideView, DiffError, diffComponents, diffDependencies } from "../src"
import { component, componentId, dependency } from "./fixtures"

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

  it("does not emit changed[] entries when the whole record is stable", () => {
    const before = component({ id: "billing", name: "billing", frameworks: [] })
    // Same id, same everything → not in changed[].
    const result = diffComponents([before], [before])
    expect(result.changed).toEqual([])
  })

  // Change detection compares the whole Component; the three booleans summarise three axes and
  // are not the definition of "changed" (diff-algorithm.md §6.1). A field outside them produced
  // no entry at all, so the projection had no before/after pair to render.
  it("reports a display-name change with all three delta booleans false", () => {
    const before = component({ id: "billing", name: "Billing" })
    const after = component({ id: "billing", name: "Billing & Invoicing" })
    const result = diffComponents([before], [after])
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]?.before.name).toBe("Billing")
    expect(result.changed[0]?.after.name).toBe("Billing & Invoicing")
    expect(result.changed[0]?.delta).toEqual({
      rootsChanged: false,
      publicApiChanged: false,
      frameworksChanged: false,
    })
  })

  it("reports an added language", () => {
    const before = component({ id: "billing", name: "billing", languages: [makeLanguageId("ts")] })
    const after = component({
      id: "billing",
      name: "billing",
      languages: [makeLanguageId("ts"), makeLanguageId("py")],
    })
    const result = diffComponents([before], [after])
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]?.after.languages).toEqual([makeLanguageId("ts"), makeLanguageId("py")])
  })

  it("reports a description added, edited and removed", () => {
    const none = component({ id: "billing", name: "billing", description: null })
    const written = component({ id: "billing", name: "billing", description: "Invoices" })
    const edited = component({
      id: "billing",
      name: "billing",
      description: "Invoices and dunning",
    })
    expect(diffComponents([none], [written]).changed).toHaveLength(1)
    expect(diffComponents([written], [edited]).changed).toHaveLength(1)
    expect(diffComponents([written], [none]).changed).toHaveLength(1)
  })

  it("still reports a changed component when name and roots move together", () => {
    const before = component({ id: "billing", name: "Billing", roots: ["apps/billing"] })
    const after = component({
      id: "billing",
      name: "Billing & Invoicing",
      roots: ["apps/billing", "packages/billing-domain"],
    })
    const result = diffComponents([before], [after])
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]?.delta.rootsChanged).toBe(true)
  })

  // ir-schema.md §1.1: an absent Class A key reads as `null` and an empty Class B list reads as
  // absent, so neither respelling is a change. A whole-record comparison has to be told this —
  // it is the one thing a byte comparison would get wrong.
  it("does not report a change when a document respells absence", () => {
    const explicit = component({
      id: "billing",
      name: "billing",
      publicApi: [],
      frameworks: [],
      description: null,
    })
    const omitted: Component = {
      id: explicit.id,
      name: explicit.name,
      roots: explicit.roots,
      languages: explicit.languages,
    }
    expect(diffComponents([explicit], [omitted]).changed).toEqual([])
    expect(diffComponents([omitted], [explicit]).changed).toEqual([])
  })

  it("does not report a change when key insertion order differs", () => {
    // Class B fields are spelled identically on both sides, so this pins key order alone and
    // does not re-test the absence respellings above.
    const a = component({
      id: "billing",
      name: "billing",
      roots: ["apps/billing"],
      description: "Invoices",
    })
    const b: Component = {
      description: "Invoices",
      languages: [makeLanguageId("ts")],
      frameworks: a.frameworks ?? [],
      publicApi: a.publicApi ?? [],
      roots: ["apps/billing"],
      name: "billing",
      id: componentId("billing"),
    }
    expect(diffComponents([a], [b]).changed).toEqual([])
  })

  // The property that justifies reaching for `@aburi/core`'s canonical serializer rather than
  // sorting keys by hand: ir-schema.md §1.2 puts every IR string in NFC, and a document that
  // arrives in NFD would otherwise report an untouched component as changed on every pull
  // request. Swap the serializer for `JSON.stringify` over sorted keys and only this fails.
  it("does not report a change when a string arrives in a different Unicode form", () => {
    const composed = "café"
    const decomposed = "cafe\u0301"
    expect(composed).not.toBe(decomposed)
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"))
    const nfc = component({ id: "billing", name: composed, description: composed })
    const nfd = component({ id: "billing", name: decomposed, description: decomposed })
    expect(diffComponents([nfc], [nfd]).changed).toEqual([])
  })

  it("reports an empty description as a change, because it is not the same as none", () => {
    const none = component({ id: "billing", name: "billing", description: null })
    const empty = component({ id: "billing", name: "billing", description: "" })
    expect(diffComponents([none], [empty]).changed).toHaveLength(1)
  })

  it("refuses a component it cannot compare, as a DiffError naming the component", () => {
    const sound = component({ id: "billing", name: "billing" })
    // A nested value JSON cannot carry. Only a hand-assembled document reaches this — which is
    // the case the error exists for, and `errors.ts` is the whole of this package's failure
    // surface, so it must not leave as a bare `CoreError` from `@aburi/core`.
    const unsound = { ...sound, roots: [(() => "apps/billing") as unknown as string] }
    let raised: unknown
    try {
      diffComponents([sound], [unsound])
    } catch (error) {
      raised = error
    }
    expect(raised).toBeInstanceOf(DiffError)
    expect((raised as DiffError).code).toBe("ir-shape-invalid")
    expect((raised as DiffError).value).toBe("components[id=billing]")
  })

  it("sorts changed[] by id", () => {
    const rename = (id: string, name: string) => component({ id, name })
    const result = diffComponents(
      [rename("z", "Z"), rename("a", "A"), rename("m", "M")],
      [rename("z", "Z2"), rename("a", "A2"), rename("m", "M2")],
    )
    expect(result.changed.map((c) => c.after.id)).toEqual(["a", "m", "z"])
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
