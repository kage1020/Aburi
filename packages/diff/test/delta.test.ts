import { describe, expect, it } from "vitest"
import { buildDiff, classifyStatus, computeSymbolDelta, dropDirection } from "../src"
import { call, decorator, effect, fp, makeIR, makeSymbol, sig, zeroFp } from "./fixtures"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

// -----------------------------------------------------------------------------
// C2 — dropped-toggled coverage (§4.1 rationale + both directions + summary)
// -----------------------------------------------------------------------------

describe("dropped-toggled status (C2)", () => {
  it("classifies dropped=false → dropped=true as dropped-toggled regardless of fingerprint", () => {
    const b = makeSymbol({ id: "ts:src/a.ts#Dto", name: "Dto", kind: "class" })
    const h = makeSymbol({
      ...b,
      dropped: true,
      dropReason: "DTO shape",
      fingerprint: zeroFp(),
    })
    expect(classifyStatus(b, h)).toBe("dropped-toggled")
    expect(dropDirection(h)).toBe("to-dropped")
  })

  it("classifies dropped=true → dropped=false as dropped-toggled (to-kept)", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      fingerprint: zeroFp(),
    })
    const h = makeSymbol({ ...b, dropped: false, dropReason: null, fingerprint: fp("v1") })
    expect(classifyStatus(b, h)).toBe("dropped-toggled")
    expect(dropDirection(h)).toBe("to-kept")
  })

  it("buildDiff increments summary.droppedToggled and omits the delta field", () => {
    const b = makeSymbol({ id: "ts:src/a.ts#Dto", name: "Dto", kind: "class" })
    const h = makeSymbol({
      ...b,
      dropped: true,
      dropReason: "DTO shape",
      fingerprint: zeroFp(),
    })
    const result = buildDiff({
      baseIR: makeIR({ symbols: [b] }),
      headIR: makeIR({ symbols: [h] }),
      base: IR_REF,
      head: IR_REF,
    })
    expect(result.summary.droppedToggled).toBe(1)
    expect(result.summary.changed).toBe(0)
    expect(result.summary.moved).toBe(0)
    const change = result.symbols[0]
    if (change?.status !== "dropped-toggled") throw new Error("expected dropped-toggled")
    expect(change.direction).toBe("to-dropped")
    // §4.1 — delta must not appear on dropped-toggled entries.
    const anyChange: Record<string, unknown> = change as unknown as Record<string, unknown>
    expect(anyChange.delta).toBeUndefined()
  })

  it("does NOT surface a DTO ruleset toggle as `changed` (§4.1 protection)", () => {
    // Simulate a DTO rule flip: multiple symbols move from kept to dropped in one PR.
    const before = [
      makeSymbol({ id: "ts:src/a.ts#A", name: "A", kind: "class" }),
      makeSymbol({ id: "ts:src/a.ts#B", name: "B", kind: "class" }),
    ]
    const after = before.map((s) => ({ ...s, dropped: true, fingerprint: zeroFp() }))
    const result = buildDiff({
      baseIR: makeIR({ symbols: before }),
      headIR: makeIR({ symbols: after }),
      base: IR_REF,
      head: IR_REF,
    })
    expect(result.summary.changed).toBe(0)
    expect(result.summary.droppedToggled).toBe(2)
  })
})

// -----------------------------------------------------------------------------
// I1 — Decorator delta (§5.2.2)
// -----------------------------------------------------------------------------

describe("Decorator delta (I1)", () => {
  it("emits modified when the same name gets a different argument list", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      decorators: [decorator({ name: "Post", arguments: ["/invoices"], line: 5 })],
    })
    const h = makeSymbol({
      ...b,
      decorators: [decorator({ name: "Post", arguments: ["/invoices/v2"], line: 5 })],
      fingerprint: { ...b.fingerprint, api: "api-changed" },
    })
    const delta = computeSymbolDelta(b, h)
    expect(delta.decorators?.modified).toHaveLength(1)
    expect(delta.decorators?.added).toHaveLength(0)
    expect(delta.decorators?.removed).toHaveLength(0)
  })

  it("emits nothing when only the line drifted within fuzz", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      decorators: [decorator({ name: "Post", arguments: ["/x"], line: 5 })],
    })
    const h = makeSymbol({
      ...b,
      decorators: [decorator({ name: "Post", arguments: ["/x"], line: 6 })],
      fingerprint: { ...b.fingerprint, syntax: "syn-drift" },
    })
    const delta = computeSymbolDelta(b, h)
    expect(delta.decorators?.modified).toHaveLength(0)
    expect(delta.decorators?.added).toHaveLength(0)
    expect(delta.decorators?.removed).toHaveLength(0)
  })

  it("emits added + removed when the name itself changed", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      decorators: [decorator({ name: "Get", line: 5 })],
    })
    const h = makeSymbol({
      ...b,
      decorators: [decorator({ name: "Post", line: 5 })],
      fingerprint: { ...b.fingerprint, api: "api-changed" },
    })
    const delta = computeSymbolDelta(b, h)
    expect(delta.decorators?.added).toHaveLength(1)
    expect(delta.decorators?.removed).toHaveLength(1)
    expect(delta.decorators?.modified).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// I2 — Effects / Calls delta
// -----------------------------------------------------------------------------

describe("Effects delta (I2)", () => {
  const shared = fp("v1")
  const baseSym = makeSymbol({
    id: "ts:src/a.ts#Foo",
    name: "Foo",
    fingerprint: shared,
    effects: [
      effect({
        id: "db.write",
        target: "prisma.user.create",
        plugin: "effects-prisma",
        line: 10,
      }),
    ],
  })

  it("emits modified when plugin/confidence changes but (id, target) survive", () => {
    const h = makeSymbol({
      ...baseSym,
      effects: [
        effect({
          id: "db.write",
          target: "prisma.user.create",
          plugin: "effects-prisma",
          confidence: "medium",
          derivedBy: "convention:test",
          line: 10,
        }),
      ],
      fingerprint: { ...shared, logic: "logic-changed" },
    })
    const delta = computeSymbolDelta(baseSym, h)
    expect(delta.effects?.modified).toHaveLength(1)
  })

  it("ignores line drift regardless of fuzz (effects use unbounded line tolerance)", () => {
    const h = makeSymbol({
      ...baseSym,
      effects: [
        effect({
          id: "db.write",
          target: "prisma.user.create",
          plugin: "effects-prisma",
          line: 10_000,
        }),
      ],
      fingerprint: { ...shared, syntax: "syn-diff" },
    })
    const delta = computeSymbolDelta(baseSym, h, { lineFuzz: 0 })
    expect(delta.effects?.added).toHaveLength(0)
    expect(delta.effects?.removed).toHaveLength(0)
    expect(delta.effects?.modified).toHaveLength(0)
  })

  it("added + removed when the target itself changed", () => {
    const h = makeSymbol({
      ...baseSym,
      effects: [
        effect({
          id: "db.write",
          target: "prisma.invoice.create",
          plugin: "effects-prisma",
          line: 10,
        }),
      ],
      fingerprint: { ...shared, logic: "logic-diff" },
    })
    const delta = computeSymbolDelta(baseSym, h)
    expect(delta.effects?.added).toHaveLength(1)
    expect(delta.effects?.removed).toHaveLength(1)
  })
})

describe("Calls delta (I2)", () => {
  const shared = fp("v1")
  const baseSym = makeSymbol({
    id: "ts:src/a.ts#Foo",
    name: "Foo",
    fingerprint: shared,
    calls: [call({ target: "helper.doWork", line: 20 })],
  })

  it("treats fuzz-eligible line drift as the same call", () => {
    const h = makeSymbol({
      ...baseSym,
      calls: [call({ target: "helper.doWork", line: 21 })],
      fingerprint: { ...shared, syntax: "syn-diff" },
    })
    const delta = computeSymbolDelta(baseSym, h, { lineFuzz: 2 })
    expect(delta.calls?.added).toHaveLength(0)
    expect(delta.calls?.removed).toHaveLength(0)
  })

  it("emits added + removed once drift exceeds the fuzz window", () => {
    const h = makeSymbol({
      ...baseSym,
      calls: [call({ target: "helper.doWork", line: 100 })],
      fingerprint: { ...shared, syntax: "syn-diff" },
    })
    const delta = computeSymbolDelta(baseSym, h, { lineFuzz: 2 })
    expect(delta.calls?.added).toHaveLength(1)
    expect(delta.calls?.removed).toHaveLength(1)
  })

  it("emits modified when resolved changes but target stays", () => {
    const h = makeSymbol({
      ...baseSym,
      calls: [call({ target: "helper.doWork", line: 20, resolved: "ts:src/util.ts#doWork" })],
      fingerprint: { ...shared, syntax: "syn-diff" },
    })
    const delta = computeSymbolDelta(baseSym, h)
    expect(delta.calls?.modified).toHaveLength(1)
  })
})

// -----------------------------------------------------------------------------
// signature delta three-branch behaviour (backs up the §5.3 JSDoc fix)
// -----------------------------------------------------------------------------

describe("Signature delta three branches", () => {
  const shared = fp("v1")

  it("returns null when both sides have no signature", () => {
    const b = makeSymbol({ id: "ts:src/a.ts#I", name: "I", kind: "interface" })
    const h = makeSymbol({
      ...b,
      fingerprint: { ...shared, syntax: "syn-diff" },
    })
    const delta = computeSymbolDelta(b, h)
    expect(delta.signature).toBeNull()
  })

  it("emits added-only signature delta when base has none and head does", () => {
    const b = makeSymbol({ id: "ts:src/a.ts#F", name: "F" })
    const h = makeSymbol({
      ...b,
      signature: sig({ inputs: [{ name: "x", type: "string" }] }),
      fingerprint: { ...shared, api: "api-diff" },
    })
    const delta = computeSymbolDelta(b, h)
    expect(delta.signature).not.toBeNull()
    expect(delta.signature?.inputs.added).toHaveLength(1)
    expect(delta.signature?.inputs.removed).toHaveLength(0)
  })

  it("emits per-list sub-deltas when both sides carry signatures", () => {
    const b = makeSymbol({
      id: "ts:src/a.ts#F",
      name: "F",
      signature: sig({ inputs: [{ name: "x", type: "string" }] }),
    })
    const h = makeSymbol({
      ...b,
      signature: sig({
        inputs: [{ name: "x", type: "number" }],
        outputs: ["boolean"],
      }),
      fingerprint: { ...shared, api: "api-diff" },
    })
    const delta = computeSymbolDelta(b, h)
    expect(delta.signature).not.toBeNull()
    // strict positional compare on `(index, name)`: same key + isEqual(a,b) false → modified
    const inputs = delta.signature?.inputs
    expect(inputs?.modified).toHaveLength(1)
    // outputs positional compare: base ["void"] vs head ["boolean"] → added + removed pair
    const outputs = delta.signature?.outputs
    expect(outputs?.added).toEqual(["boolean"])
    expect(outputs?.removed).toEqual(["void"])
  })
})
