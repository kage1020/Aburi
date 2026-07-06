import { describe, expect, it } from "vitest"
import { buildDiff, DiffError } from "../src"
import { component, dependency, fp, makeIR, makeSymbol, rule, sig, zeroFp } from "./fixtures"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

function diff(
  baseIR: Parameters<typeof buildDiff>[0]["baseIR"],
  headIR: typeof baseIR,
  extras: Partial<Parameters<typeof buildDiff>[0]> = {},
) {
  return buildDiff({ baseIR, headIR, base: IR_REF, head: IR_REF, ...extras })
}

/** Convenience: find the single change matching a predicate. */
function findChange(
  changes: ReturnType<typeof buildDiff>["symbols"],
  predicate: (c: (typeof changes)[number]) => boolean,
) {
  const hit = changes.find(predicate)
  if (hit === undefined) throw new Error("Expected exactly one matching change")
  return hit
}

describe("DF1 — identical IRs", () => {
  it("emits an empty diff", () => {
    const s = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })
    const ir = makeIR({ symbols: [s] })
    const result = diff(ir, ir)
    expect(result.summary.added).toBe(0)
    expect(result.summary.removed).toBe(0)
    expect(result.summary.changed).toBe(0)
    expect(result.summary.unchanged).toBe(1)
    expect(result.symbols).toEqual([])
    expect(result.components.added).toEqual([])
    expect(result.dependencies.added).toEqual([])
  })
})

describe("DF2 — one added symbol in head", () => {
  it("increments summary.added and lists the symbol", () => {
    const base = makeIR({ symbols: [] })
    const head = makeIR({
      symbols: [makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })],
    })
    const result = diff(base, head)
    expect(result.summary.added).toBe(1)
    expect(result.symbols).toHaveLength(1)
    expect(result.symbols[0]).toMatchObject({ status: "added" })
  })
})

describe("DF3 — one removed symbol in base", () => {
  it("increments summary.removed", () => {
    const base = makeIR({
      symbols: [makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })],
    })
    const head = makeIR({ symbols: [] })
    const result = diff(base, head)
    expect(result.summary.removed).toBe(1)
    expect(result.symbols[0]).toMatchObject({ status: "removed" })
  })
})

describe("DF4 — rule condition changed", () => {
  it("marks change with logicChanged=true, apiChanged=false", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      fingerprint: fp("v1"),
      rules: [rule({ type: "guard", line: 5, condition: "x > 0" })],
    })
    const h = makeSymbol({
      ...b,
      fingerprint: { ...fp("v1"), logic: "logic-changed" },
      rules: [rule({ type: "guard", line: 5, condition: "x >= 0" })],
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }))
    const c = findChange(result.symbols, (x) => x.status === "changed")
    expect(c.status).toBe("changed")
    if (c.status !== "changed") throw new Error("unreachable")
    expect(c.delta.logicChanged).toBe(true)
    expect(c.delta.apiChanged).toBe(false)
    expect(c.delta.rules?.modified).toHaveLength(1)
  })
})

describe("DF5 — signature outputs changed", () => {
  it("marks apiChanged=true", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      signature: sig({ outputs: ["Promise<Invoice>"] }),
    })
    const h = makeSymbol({
      ...b,
      fingerprint: { ...b.fingerprint, api: "api-v2" },
      signature: sig({ outputs: ["Promise<InvoiceWithReceipt>"] }),
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }))
    const c = findChange(result.symbols, (x) => x.status === "changed")
    if (c.status !== "changed") throw new Error("unreachable")
    expect(c.delta.apiChanged).toBe(true)
    expect(c.delta.signature?.outputs.added).toContain("Promise<InvoiceWithReceipt>")
    expect(c.delta.signature?.outputs.removed).toContain("Promise<Invoice>")
  })
})

describe("DF6 — file renamed (git rename map)", () => {
  it("emits moved with rationale git-rename", () => {
    const b = makeSymbol({ id: "ts:src/old.ts#Foo", name: "Foo" })
    const h = makeSymbol({
      id: "ts:src/new.ts#Foo",
      name: "Foo",
      source: { ...b.source, file: "src/new.ts" },
    })
    const renames = new Map([["src/old.ts", "src/new.ts"]])
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }), {
      gitRenames: renames,
    })
    expect(result.summary.moved).toBe(1)
    const c = findChange(result.symbols, (x) => x.status === "moved")
    if (c.status !== "moved") throw new Error("unreachable")
    expect(c.rationale).toBe("git-rename")
  })
})

describe("DF7 — file renamed + rule added", () => {
  it("emits moved+changed with git-rename rationale", () => {
    const b = makeSymbol({
      id: "ts:src/old.ts#Foo",
      name: "Foo",
      fingerprint: fp("v1"),
    })
    const h = makeSymbol({
      id: "ts:src/new.ts#Foo",
      name: "Foo",
      source: { ...b.source, file: "src/new.ts" },
      fingerprint: { ...fp("v1"), logic: "logic-new" },
      rules: [rule({ type: "guard", line: 8, condition: "x != null" })],
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }), {
      gitRenames: new Map([["src/old.ts", "src/new.ts"]]),
    })
    expect(result.summary.movedChanged).toBe(1)
    const c = findChange(result.symbols, (x) => x.status === "moved+changed")
    if (c.status !== "moved+changed") throw new Error("unreachable")
    expect(c.rationale).toBe("git-rename")
    expect(c.delta.logicChanged).toBe(true)
    expect(c.delta.rules?.added).toHaveLength(1)
  })
})

describe("DF8 — file renamed with logic-fp match (no git)", () => {
  it("emits moved with rationale logic-fingerprint", () => {
    const shared = fp("logic-shared")
    const b = makeSymbol({ id: "ts:src/old.ts#Foo", name: "Foo", fingerprint: shared })
    const h = makeSymbol({
      id: "ts:src/new.ts#Foo",
      name: "Foo",
      source: { ...b.source, file: "src/new.ts" },
      fingerprint: shared,
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }))
    expect(result.summary.moved).toBe(1)
    const c = findChange(result.symbols, (x) => x.status === "moved")
    if (c.status !== "moved") throw new Error("unreachable")
    expect(c.rationale).toBe("logic-fingerprint")
  })
})

describe("DF9 — method rename in same file, same logic", () => {
  it("emits moved with rationale logic-fingerprint", () => {
    const shared = fp("v1")
    const b = makeSymbol({
      id: "ts:src/a.ts#Cls.getUser",
      name: "Cls.getUser",
      kind: "method",
      fingerprint: shared,
      signature: sig({ inputs: [{ name: "id", type: "string" }] }),
    })
    const h = makeSymbol({
      ...b,
      id: "ts:src/a.ts#Cls.fetchUser",
      name: "Cls.fetchUser",
      fingerprint: shared,
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }))
    expect(result.summary.moved).toBe(1)
    const c = findChange(result.symbols, (x) => x.status === "moved")
    if (c.status !== "moved") throw new Error("unreachable")
    expect(c.rationale).toBe("logic-fingerprint")
  })
})

describe("DF10 — multiple base symbols share logic-fp, disambiguate by name", () => {
  it("picks the name-closest candidate", () => {
    const shared = fp("v1")
    const rival = makeSymbol({
      id: "ts:src/a.ts#Cls.completelyDifferent",
      name: "Cls.completelyDifferent",
      kind: "method",
      fingerprint: shared,
    })
    const winner = makeSymbol({
      id: "ts:src/a.ts#Cls.getUserById",
      name: "Cls.getUserById",
      kind: "method",
      fingerprint: shared,
    })
    const h = makeSymbol({
      ...winner,
      id: "ts:src/a.ts#Cls.getUserById",
      name: "Cls.getUserById",
      fingerprint: shared,
    })
    const result = diff(makeIR({ symbols: [rival, winner] }), makeIR({ symbols: [h] }))
    expect(result.summary.unchanged).toBe(1)
    expect(result.summary.removed).toBe(1)
  })
})

describe("DF11 — component added", () => {
  it("lists the component under components.added", () => {
    const base = makeIR({ components: [] })
    const head = makeIR({ components: [component({ id: "billing", name: "billing" })] })
    const result = diff(base, head)
    expect(result.summary.componentsAdded).toBe(1)
    expect(result.components.added).toHaveLength(1)
  })
})

describe("DF12 — dependency added", () => {
  it("lists the dependency under dependencies.added", () => {
    const base = makeIR({ dependencies: [] })
    const head = makeIR({
      dependencies: [dependency({ from: "billing", to: "payments" })],
    })
    const result = diff(base, head)
    expect(result.summary.depsAdded).toBe(1)
    expect(result.dependencies.added).toHaveLength(1)
  })
})

describe("DF13 — dropped symbol paired by ID", () => {
  it("counts as unchanged", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      dropReason: "DTO",
      fingerprint: zeroFp(),
    })
    const ir = makeIR({ symbols: [s] })
    const result = diff(ir, ir)
    expect(result.summary.unchanged).toBe(1)
    expect(result.summary.droppedAdded).toBe(0)
    expect(result.summary.droppedRemoved).toBe(0)
  })
})

describe("DF14 — dropped symbol vanished with new basename", () => {
  it("counts under droppedRemoved when weak match fails", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const other = makeSymbol({
      id: "ts:src/b.ts#TotallyDifferent",
      name: "TotallyDifferent",
      kind: "interface",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [other] }))
    expect(result.summary.droppedRemoved).toBe(1)
    expect(result.summary.droppedAdded).toBe(1)
  })
})

describe("DF14b — dropped symbol moved directories with same basename", () => {
  it("recovers as moved via dropped-weak-match", () => {
    const b = makeSymbol({
      id: "ts:src/old/dto.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const h = makeSymbol({
      id: "ts:src/new/dto.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      fingerprint: zeroFp(),
      source: { ...b.source, file: "src/new/dto.ts" },
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }))
    expect(result.summary.moved).toBe(1)
    const c = findChange(result.symbols, (x) => x.status === "moved")
    if (c.status !== "moved") throw new Error("unreachable")
    expect(c.rationale).toBe("dropped-weak-match")
  })
})

describe("DF15 — schema mismatch", () => {
  it("throws DiffError", () => {
    const base = makeIR({ $schema: "https://aburi.dev/schema/aburi.ir.v1.json" })
    const head = makeIR({ $schema: "https://aburi.dev/schema/aburi.ir.v2.json" as never })
    expect(() => diff(base, head)).toThrow(DiffError)
  })
})

describe("DF16 — same rule, line drift within fuzz (±2)", () => {
  it("does not produce a modified delta", () => {
    const shared = fp("v1")
    const b = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      fingerprint: shared,
      rules: [rule({ type: "guard", line: 5, condition: "x > 0" })],
    })
    const h = makeSymbol({
      ...b,
      // 5→6 within default fuzz (±2)
      rules: [rule({ type: "guard", line: 6, condition: "x > 0" })],
      // Force fingerprint to differ so we hit the delta path
      fingerprint: { ...shared, syntax: "syn-changed" },
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }))
    const c = findChange(result.symbols, (x) => x.status === "changed")
    if (c.status !== "changed") throw new Error("unreachable")
    expect(c.delta.rules?.modified).toHaveLength(0)
    expect(c.delta.rules?.added).toHaveLength(0)
    expect(c.delta.rules?.removed).toHaveLength(0)
  })
})

describe("DF17 — same rule with big line drift (> fuzz)", () => {
  it("produces added + removed pair", () => {
    const shared = fp("v1")
    const b = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      fingerprint: shared,
      rules: [rule({ type: "guard", line: 5, condition: "x > 0" })],
    })
    const h = makeSymbol({
      ...b,
      rules: [rule({ type: "guard", line: 55, condition: "x > 0" })],
      fingerprint: { ...shared, syntax: "syn-changed" },
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }), {
      delta: { lineFuzz: 2 },
    })
    const c = findChange(result.symbols, (x) => x.status === "changed")
    if (c.status !== "changed") throw new Error("unreachable")
    expect(c.delta.rules?.added).toHaveLength(1)
    expect(c.delta.rules?.removed).toHaveLength(1)
  })
})

describe("DF18 — syntax-only change", () => {
  it("marks only syntaxChanged", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      fingerprint: fp("v1"),
    })
    const h = makeSymbol({
      ...b,
      fingerprint: { ...fp("v1"), syntax: "syn-v2" },
    })
    const result = diff(makeIR({ symbols: [b] }), makeIR({ symbols: [h] }))
    const c = findChange(result.symbols, (x) => x.status === "changed")
    if (c.status !== "changed") throw new Error("unreachable")
    expect(c.delta.syntaxChanged).toBe(true)
    expect(c.delta.apiChanged).toBe(false)
    expect(c.delta.logicChanged).toBe(false)
  })
})
