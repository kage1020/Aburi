import { changed } from "@aburi/test-support"
import type { ArrayDelta, SignatureDelta, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { LONG_CONDITION, namedSymbol, projectChanges } from "./fixtures"

function none(): ArrayDelta {
  return { added: [], removed: [], modified: [] }
}

function signature(overrides: Partial<SignatureDelta>): SignatureDelta {
  return {
    inputs: none(),
    outputs: none(),
    throws: none(),
    asyncChanged: false,
    generatorChanged: false,
    typeParametersChanged: false,
    ...overrides,
  }
}

function renderDelta(flags: Partial<SymbolDelta>): string {
  return projectChanges([changed(namedSymbol("Foo"), { apiChanged: true, ...flags })])
}

describe("a changed Symbol's signature rows", () => {
  it.each<[string, Partial<SignatureDelta>, string]>([
    [
      "the outputs as before → after",
      { outputs: { added: ["Promise<B>"], removed: ["Promise<A>"], modified: [] } },
      "- signature.outputs: `Promise<A>` → `Promise<B>`\n",
    ],
    [
      "modified outputs and throws",
      {
        outputs: { ...none(), modified: ["Promise<User>"] },
        throws: { ...none(), modified: ["NotFoundError"] },
      },
      "- signature.outputs modified: `Promise<User>`\n- signature.throws modified: `NotFoundError`\n",
    ],
    [
      "added and removed throws on rows of their own",
      { throws: { added: ["NotFound"], removed: ["Legacy"], modified: [] } },
      "- signature.throws added: `NotFound`\n- signature.throws removed: `Legacy`\n",
    ],
    [
      "each added and removed input by name and type, not as a count",
      {
        inputs: {
          added: [{ name: "b", type: "number" }],
          removed: [{ name: "a", type: "string" }],
          modified: [],
        },
      },
      "- signature.inputs added: `b: number`\n- signature.inputs removed: `a: string`\n",
    ],
    [
      "an added rest input with its `...`",
      { inputs: { ...none(), added: [{ name: "ids", type: "string[]", rest: true }] } },
      "- signature.inputs added: `...ids: string[]`\n",
    ],
    [
      "the parameter and its new type when an input's type changes",
      { inputs: { ...none(), modified: [{ name: "id", type: "number" }] } },
      "- signature.inputs modified: `id: number`\n",
    ],
    [
      "a count for inputs none of which can be read",
      { inputs: { ...none(), removed: [{ name: 1 }, "id"] } },
      "- signature.inputs removed: 2 item(s)\n",
    ],
    [
      "the async, generator and type-parameter toggles",
      { asyncChanged: true, generatorChanged: true, typeParametersChanged: true },
      "- signature.async: toggled\n- signature.generator: toggled\n- signature.typeParameters: changed\n",
    ],
  ])("names %s", (_, overrides, rows) => {
    expect(renderDelta({ signature: signature(overrides) })).toContain(rows)
  })
})

describe("a changed Symbol's decorator rows", () => {
  it.each<[string, keyof ArrayDelta, Record<string, unknown>, string]>([
    [
      "an added decorator as written",
      "added",
      { name: "Post", raw: "Post('/x')", arguments: ["'/x'"], boundary: false, line: 3 },
      "- decorator added: `@Post('/x')`",
    ],
    [
      "a removed decorator as written",
      "removed",
      { name: "Legacy", raw: "Legacy()", arguments: [], boundary: false, line: 5 },
      "- decorator removed: `@Legacy()`",
    ],
    [
      "a modified decorator by name, without the arguments that may be what changed",
      "modified",
      { name: "UseGuards", raw: "UseGuards(A,B)", arguments: [], boundary: false, line: 7 },
      "- decorator modified: `@UseGuards`",
    ],
    [
      "a modified decorator with its receiver, which may be what changed",
      "modified",
      { name: "Post", qualifier: "tsed", raw: "tsed.Post('/x')", arguments: [], line: 7 },
      "- decorator modified: `@tsed.Post`",
    ],
    [
      "a multi-segment receiver whole",
      "modified",
      { name: "Post", qualifier: "a.b", raw: "a.b.Post()", arguments: [], line: 7 },
      "- decorator modified: `@a.b.Post`",
    ],
    [
      "an added decorator with no raw form by its name and receiver",
      "added",
      { name: "Post", qualifier: "nest", arguments: [], boundary: false, line: 3 },
      "- decorator added: `@nest.Post`",
    ],
    [
      "an empty receiver as no receiver at all",
      "modified",
      { name: "Post", qualifier: "", raw: "Post()", arguments: [], boundary: false, line: 7 },
      "- decorator modified: `@Post`\n",
    ],
  ])("names %s", (_, bucket, entry, row) => {
    expect(renderDelta({ decorators: { ...none(), [bucket]: [entry] } })).toContain(row)
  })
})

describe("a changed Symbol's rule, effect and call rows", () => {
  it.each<[string, Partial<SymbolDelta>, string]>([
    [
      "an added rule by type, payload and line",
      { rules: { ...none(), added: [{ type: "guard", line: 12, condition: "x > 0" }] } },
      "- rules added:\n  - guard: `x > 0` (L12)\n",
    ],
    [
      "a rule with no payload by type and line",
      { rules: { ...none(), removed: [{ type: "try", line: 5 }] } },
      "- rules removed:\n  - try (L5)\n",
    ],
    [
      "a rewritten guard condition",
      {
        rules: {
          ...none(),
          modified: [
            {
              type: "guard",
              line: 3,
              condition: "user.isAdmin && !user.banned",
              what: null,
              expr: null,
              loopKind: null,
            },
          ],
        },
      },
      "- rules modified:\n  - guard: `user.isAdmin && !user.banned` (L3)\n",
    ],
    [
      "a condition too long for a code span inline all the same",
      { rules: { ...none(), added: [{ type: "guard", line: 3, condition: LONG_CONDITION }] } },
      `- rules added:\n  - guard: \`${LONG_CONDITION}\` (L3)\n`,
    ],
    [
      "an added effect by id, target and line",
      {
        effects: { ...none(), added: [{ id: "db.write", target: "prisma.user.create", line: 42 }] },
      },
      "- effects added:\n  - db.write: `prisma.user.create` (L42)\n",
    ],
    [
      "an effect whose confidence was downgraded",
      {
        effects: {
          ...none(),
          modified: [
            {
              id: "db.write",
              target: "prisma.user.create",
              line: 7,
              plugin: "effects-prisma",
              confidence: "low",
              derivedBy: "x",
            },
          ],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` (L7)\n",
    ],
    [
      "a propagated effect by its direct sources",
      {
        effects: {
          ...none(),
          modified: [
            {
              id: "db.write",
              target: "prisma.user.create",
              plugin: "effects-prisma",
              confidence: "high",
              derivedBy: "effects-plugin:prisma:write",
              propagated: true,
              derivedFrom: ["ts:src/repository.ts#Repository.save"],
            },
          ],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` [propagated from ts:src/repository.ts#Repository.save]\n",
    ],
    [
      "a removed call by target and line",
      { calls: { ...none(), removed: [{ target: "helper.doWork", line: 8 }] } },
      "- calls removed:\n  - `helper.doWork` (L8)\n",
    ],
    [
      "a call that stopped resolving",
      { calls: { ...none(), modified: [{ target: "useInvoices", line: 15, resolved: null }] } },
      "- calls modified:\n  - `useInvoices` (L15)\n",
    ],
  ])("names %s", (_, flags, rows) => {
    expect(renderDelta(flags)).toContain(rows)
  })
})

describe("a changed Symbol's delta entries that cannot be read", () => {
  it.each<[string, Partial<SymbolDelta>, string]>([
    [
      "a decorator with no name",
      { decorators: { ...none(), added: [{ nope: "x" }] } },
      "decorator",
    ],
    ["a rule with no line", { rules: { ...none(), added: [{ type: "guard" }] } }, "rules added"],
    [
      "a local effect with no line",
      { effects: { ...none(), removed: [{ id: "db.read", target: "t" }] } },
      "effects removed",
    ],
    ["a call with no target", { calls: { ...none(), added: [{ line: 3 }] } }, "calls added"],
    [
      "a throw that is not a string",
      { signature: signature({ throws: { ...none(), added: [42] } }) },
      "signature.throws",
    ],
  ])("writes no row for %s", (_, flags, label) => {
    const md = renderDelta(flags)
    expect(md).not.toContain(label)
    expect(md).not.toContain("@?")
  })
})

describe("a changed Symbol's component, visibility and confidence rows", () => {
  it("writes the confidence row after the component and visibility rows", () => {
    const md = projectChanges([
      changed(
        namedSymbol("Foo"),
        {
          apiChanged: true,
          componentChanged: true,
          visibilityChanged: true,
          confidenceChanged: true,
        },
        { confidence: "low" },
      ),
    ])
    expect(md).toContain(
      "- component: changed\n- visibility: changed\n- confidence: `high` → `low`\n",
    )
  })
})
