import { makeLanguageId } from "@aburi/core"
import { component, componentId, dependency, errorFrom } from "@aburi/test-support"
import type { Component, ComponentDiff, Dependency } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DiffError, diffComponents, diffDependencies, renameDirections } from "../src"

type ComponentDelta = ComponentDiff["changed"][number]["delta"]

const UNCHANGED_AXES: ComponentDelta = {
  rootsChanged: false,
  publicApiChanged: false,
  frameworksChanged: false,
}

const billing = (overrides: Partial<Omit<Component, "id">> = {}) =>
  component({ id: "billing", name: "billing", ...overrides })

describe("diffComponents", () => {
  it("reports nothing for a Component both sides hold unchanged", () => {
    expect(diffComponents([billing()], [billing()])).toEqual({
      added: [],
      removed: [],
      changed: [],
    })
  })

  it("lists added and removed Components, each sorted by id", () => {
    const named = (id: string) => component({ id, name: id })
    const result = diffComponents(
      [named("zeta"), named("kept"), named("alpha")],
      [named("omega"), named("kept"), named("beta")],
    )
    expect(result.added.map((c) => c.id)).toEqual(["beta", "omega"])
    expect(result.removed.map((c) => c.id)).toEqual(["alpha", "zeta"])
    expect(result.changed).toEqual([])
  })

  it.each<[string, Partial<Component>, Partial<Component>, keyof ComponentDelta]>([
    [
      "roots",
      { roots: ["apps/billing"] },
      { roots: ["apps/billing", "packages/billing-domain"] },
      "rootsChanged",
    ],
    [
      "publicApi",
      { publicApi: ["apps/billing/routes/**"] },
      { publicApi: ["apps/billing/routes/**", "apps/billing/api/**"] },
      "publicApiChanged",
    ],
    ["frameworks", { frameworks: [] }, { frameworks: ["nestjs"] }, "frameworksChanged"],
  ])("flags only %s when that field moves", (_, before, after, flag) => {
    const result = diffComponents([billing(before)], [billing(after)])
    expect(result.changed.map((entry) => entry.delta)).toEqual([
      { ...UNCHANGED_AXES, [flag]: true },
    ])
  })

  it.each<[string, Partial<Component>, Partial<Component>]>([
    ["a renamed Component", { name: "Billing" }, { name: "Billing & Invoicing" }],
    [
      "an added language",
      { languages: [makeLanguageId("ts")] },
      { languages: [makeLanguageId("ts"), makeLanguageId("py")] },
    ],
    ["a description written", { description: null }, { description: "Invoices" }],
    ["a description edited", { description: "Invoices" }, { description: "Invoices and dunning" }],
    ["a description removed", { description: "Invoices" }, { description: null }],
    ["an empty description where there was none", { description: null }, { description: "" }],
  ])("reports %s as changed, carrying both sides whole with all three axes false", (_, before, after) => {
    const result = diffComponents([billing(before)], [billing(after)])
    expect(result.changed).toEqual([
      { before: billing(before), after: billing(after), delta: UNCHANGED_AXES },
    ])
  })

  it("does not report a change when a document respells absence", () => {
    const explicit = billing({ publicApi: [], frameworks: [], description: null })
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
    const a = billing({ roots: ["apps/billing"], description: "Invoices" })
    const b: Component = {
      description: "Invoices",
      languages: [makeLanguageId("ts")],
      frameworks: [],
      publicApi: [],
      roots: ["apps/billing"],
      name: "billing",
      id: componentId("billing"),
    }
    expect(diffComponents([a], [b]).changed).toEqual([])
  })

  it("does not report a change when a string arrives in a different Unicode form", () => {
    const composed = "café"
    const decomposed = "café"
    expect(composed).not.toBe(decomposed)
    expect(
      diffComponents(
        [billing({ name: composed, description: composed })],
        [billing({ name: decomposed, description: decomposed })],
      ).changed,
    ).toEqual([])
  })

  it("sorts changed[] by id", () => {
    const renamed = (id: string, name: string) => component({ id, name })
    const result = diffComponents(
      [renamed("z", "Z"), renamed("a", "A"), renamed("m", "M")],
      [renamed("z", "Z2"), renamed("a", "A2"), renamed("m", "M2")],
    )
    expect(result.changed.map((c) => c.after.id)).toEqual(["a", "m", "z"])
  })

  it("refuses a Component it cannot compare, naming it and keeping the cause", async () => {
    const unsound = billing({ roots: [(() => "apps/billing") as unknown as string] })
    const error = await errorFrom(DiffError, () => diffComponents([billing()], [unsound]))
    expect(error).toMatchObject({ code: "ir-shape-invalid", value: "components[id=billing]" })
    expect(error.message).toMatch(/^head components\[id=billing\] cannot be compared: /)
    expect(error.cause).toBeInstanceOf(Error)
  })
})

describe("diffDependencies", () => {
  const NO_LOSSES = {
    base: { symbolFiles: new Map(), lostFiles: new Map() },
    head: { symbolFiles: new Map(), lostFiles: new Map() },
    renames: renameDirections(null),
  }
  const billingToPayments = (overrides: Partial<Dependency> = {}) =>
    dependency({ from: "billing", to: "payments", via: "call", ...overrides })

  it.each<[string, Partial<Dependency>, Partial<Dependency>]>([
    ["direction", { direction: "outbound" }, { direction: "inbound" }],
    ["effect", { effect: null }, { effect: "db.write" }],
  ])("reports an edge whose %s changed as an added + removed pair", (_, before, after) => {
    expect(
      diffDependencies([billingToPayments(before)], [billingToPayments(after)], NO_LOSSES),
    ).toEqual({
      added: [billingToPayments(after)],
      removed: [billingToPayments(before)],
      unknown: [],
    })
  })

  it("reports an edge only base holds as removed, and one only head holds as added", () => {
    const old = dependency({ from: "a", to: "b" })
    const fresh = dependency({ from: "a", to: "c" })
    expect(diffDependencies([old], [fresh], NO_LOSSES)).toEqual({
      added: [fresh],
      removed: [old],
      unknown: [],
    })
  })

  it("sorts Component and Symbol edges together by (from, to, via)", () => {
    const symbolEdge = dependency({
      from: "ts:src/a.ts#caller",
      to: "ts:src/util.ts#helper",
      via: "call",
    })
    const za = dependency({ from: "z", to: "a" })
    const az = dependency({ from: "a", to: "z" })
    const ab = dependency({ from: "a", to: "b" })
    expect(diffDependencies([], [symbolEdge, za, az, ab], NO_LOSSES).added).toEqual([
      ab,
      az,
      symbolEdge,
      za,
    ])
  })
})
