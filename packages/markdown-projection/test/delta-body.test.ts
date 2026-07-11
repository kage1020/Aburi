import type { SymbolChanged, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { emptySummary, fp, makeDiff, makeSymbol } from "./fixtures"

/**
 * C6 — renderDeltaBody branch coverage. Each test drives a single delta field so we can
 * assert the emitted row in isolation. Signature is stitched together from ArrayDeltas
 * because the schema's ArrayDelta uses `unknown[]` and the runtime shape has to match.
 */

function baseDelta(): SymbolDelta {
  return {
    apiChanged: true, // force routing into API changes so the block emits
    logicChanged: false,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
    rules: { added: [], removed: [], modified: [] },
    effects: { added: [], removed: [], modified: [] },
    calls: { added: [], removed: [], modified: [] },
    decorators: { added: [], removed: [], modified: [] },
    signature: null,
  }
}

function wrap(delta: SymbolDelta): SymbolChanged {
  const before = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo", fingerprint: fp("v1") })
  return {
    status: "changed",
    before,
    after: { ...before, fingerprint: fp("v2") },
    delta,
  }
}

function renderWith(delta: SymbolDelta): string {
  return projectDiff(
    makeDiff({
      summary: { ...emptySummary(), changed: 1 },
      symbols: [wrap(delta)],
    }),
  )
}

describe("renderDeltaBody — signature branches", () => {
  it("emits outputs before → after row", () => {
    const md = renderWith({
      ...baseDelta(),
      signature: {
        inputs: { added: [], removed: [], modified: [] },
        outputs: { added: ["Promise<B>"], removed: ["Promise<A>"], modified: [] },
        throws: { added: [], removed: [], modified: [] },
        asyncChanged: false,
        generatorChanged: false,
        typeParametersChanged: false,
      },
    })
    expect(md).toContain("- signature.outputs: `Promise<A>` → `Promise<B>`")
  })

  it("emits throws added / removed on separate rows", () => {
    const md = renderWith({
      ...baseDelta(),
      signature: {
        inputs: { added: [], removed: [], modified: [] },
        outputs: { added: [], removed: [], modified: [] },
        throws: { added: ["NotFound"], removed: ["Legacy"], modified: [] },
        asyncChanged: false,
        generatorChanged: false,
        typeParametersChanged: false,
      },
    })
    expect(md).toContain("- signature.throws added: `NotFound`")
    expect(md).toContain("- signature.throws removed: `Legacy`")
  })

  it("emits input added/removed counts", () => {
    const md = renderWith({
      ...baseDelta(),
      signature: {
        inputs: {
          added: [{ name: "b", type: "number" }],
          removed: [{ name: "a", type: "string" }],
          modified: [],
        },
        outputs: { added: [], removed: [], modified: [] },
        throws: { added: [], removed: [], modified: [] },
        asyncChanged: false,
        generatorChanged: false,
        typeParametersChanged: false,
      },
    })
    expect(md).toContain("- signature.inputs added: 1 item(s)")
    expect(md).toContain("- signature.inputs removed: 1 item(s)")
  })

  it("emits async / generator / typeParameters toggles", () => {
    const md = renderWith({
      ...baseDelta(),
      signature: {
        inputs: { added: [], removed: [], modified: [] },
        outputs: { added: [], removed: [], modified: [] },
        throws: { added: [], removed: [], modified: [] },
        asyncChanged: true,
        generatorChanged: true,
        typeParametersChanged: true,
      },
    })
    expect(md).toContain("- signature.async: toggled")
    expect(md).toContain("- signature.generator: toggled")
    expect(md).toContain("- signature.typeParameters: changed")
  })
})

describe("renderDeltaBody — decorator branches", () => {
  it("added → uses raw when present, name as fallback", () => {
    const md = renderWith({
      ...baseDelta(),
      decorators: {
        added: [{ name: "Post", raw: "Post('/x')", arguments: ["'/x'"], boundary: false, line: 3 }],
        removed: [],
        modified: [],
      },
    })
    expect(md).toContain("- decorator added: `@Post('/x')`")
  })

  it("removed → same shape", () => {
    const md = renderWith({
      ...baseDelta(),
      decorators: {
        added: [],
        removed: [{ name: "Legacy", raw: "Legacy()", arguments: [], boundary: false, line: 5 }],
        modified: [],
      },
    })
    expect(md).toContain("- decorator removed: `@Legacy()`")
  })

  it("modified → uses `name`", () => {
    const md = renderWith({
      ...baseDelta(),
      decorators: {
        added: [],
        removed: [],
        modified: [
          { name: "UseGuards", raw: "UseGuards(A,B)", arguments: [], boundary: false, line: 7 },
        ],
      },
    })
    expect(md).toContain("- decorator modified: `@UseGuards`")
  })

  it("skips malformed entries silently rather than emitting `@?`", () => {
    const md = renderWith({
      ...baseDelta(),
      decorators: {
        added: [{ nope: "no name field" }],
        removed: [],
        modified: [],
      },
    })
    expect(md).not.toContain("@?")
    expect(md).not.toContain("decorator added")
  })
})

describe("renderDeltaBody — rules/effects/calls added/removed", () => {
  it("rules added: type + condition + line", () => {
    const md = renderWith({
      ...baseDelta(),
      rules: {
        added: [{ type: "guard", line: 12, condition: "x > 0" }],
        removed: [],
        modified: [],
      },
    })
    expect(md).toContain("- rules added:")
    expect(md).toContain("  - guard: `x > 0` (L12)")
  })

  it("effects added: id + target + line", () => {
    const md = renderWith({
      ...baseDelta(),
      effects: {
        added: [{ id: "db.write", target: "prisma.user.create", line: 42 }],
        removed: [],
        modified: [],
      },
    })
    expect(md).toContain("- effects added:")
    expect(md).toContain("  - db.write: `prisma.user.create` (L42)")
  })

  it("calls removed: target + line", () => {
    const md = renderWith({
      ...baseDelta(),
      calls: {
        added: [],
        removed: [{ target: "helper.doWork", line: 8 }],
        modified: [],
      },
    })
    expect(md).toContain("- calls removed:")
    expect(md).toContain("  - `helper.doWork` (L8)")
  })
})

describe("renderDeltaBody — component / visibility", () => {
  it("emits component changed", () => {
    const md = renderWith({ ...baseDelta(), componentChanged: true })
    expect(md).toContain("- component: changed")
  })

  it("emits visibility changed", () => {
    const md = renderWith({ ...baseDelta(), visibilityChanged: true })
    expect(md).toContain("- visibility: changed")
  })
})
