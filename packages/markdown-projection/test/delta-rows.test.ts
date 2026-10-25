import { call, changed, componentId, decorator, effect, rule, sig } from "@aburi/test-support"
import type {
  ArrayDelta,
  Symbol as IRSymbol,
  Signature,
  SignatureDelta,
  SymbolDelta,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { LONG_CONDITION, namedSymbol, projectChanges, renamedPair } from "./fixtures"
import { sectionOf } from "./markdown"

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

type SymbolArrays = Parameters<typeof namedSymbol>[1]

/** `flags` describe how the arrays in `before` became those in `after`. */
function renderDelta(
  flags: Partial<SymbolDelta>,
  before: SymbolArrays = {},
  after: Partial<IRSymbol> = {},
): string {
  return projectChanges([
    changed(namedSymbol("Foo", before), { apiChanged: true, ...flags }, after),
  ])
}

/** A schema-invalid copy of `value` without `key`. */
function lacking<T extends object>(value: T, key: keyof T): T {
  const copy = { ...value }
  Reflect.deleteProperty(copy, key)
  return copy
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
  ])("names %s", (_, overrides, rows) => {
    expect(renderDelta({ signature: signature(overrides) })).toContain(rows)
  })

  it.each<[string, Partial<SignatureDelta>, Signature | null, Signature, string]>([
    [
      "an async toggle",
      { asyncChanged: true },
      sig(),
      sig({ async: true }),
      "- signature.async: false → true\n",
    ],
    [
      "a generator toggle",
      { generatorChanged: true },
      sig({ generator: true }),
      sig(),
      "- signature.generator: true → false\n",
    ],
    [
      "an async toggle on a Symbol that had no signature",
      { asyncChanged: true },
      null,
      sig({ async: true }),
      "- signature.async: false → true\n",
    ],
    [
      "type parameters gained",
      { typeParametersChanged: true },
      sig(),
      sig({ typeParameters: ["N extends SyntaxNode"] }),
      "- signature.typeParameters: none → `<N extends SyntaxNode>`\n",
    ],
    [
      "type parameters edited",
      { typeParametersChanged: true },
      sig({ typeParameters: ["T"] }),
      sig({ typeParameters: ["T", "U = T"] }),
      "- signature.typeParameters: `<T>` → `<T,U = T>`\n",
    ],
  ])("sets the base value before the head one for %s", (_, overrides, before, after, row) => {
    const md = renderDelta(
      { signature: signature(overrides) },
      { signature: before },
      { signature: after },
    )
    expect(md).toContain(row)
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
      "a modified decorator with no base to set beside it as written, arguments included",
      "modified",
      { name: "UseGuards", raw: "UseGuards(A,B)", arguments: ["A", "B"], line: 7 },
      "- decorator modified: `@UseGuards(A,B)`\n",
    ],
    [
      "an added decorator with no raw form by its name and receiver",
      "added",
      { name: "Post", qualifier: "nest", arguments: [], boundary: false, line: 3 },
      "- decorator added: `@nest.Post`",
    ],
    [
      "a multi-segment receiver whole",
      "added",
      { name: "Post", qualifier: "a.b", arguments: [], line: 7 },
      "- decorator added: `@a.b.Post`",
    ],
    [
      "an empty receiver as no receiver at all",
      "added",
      { name: "Post", qualifier: "", arguments: [], boundary: false, line: 7 },
      "- decorator added: `@Post`\n",
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
      "an added loop by its kind",
      { rules: { ...none(), added: [rule({ type: "loop", line: 9, loopKind: "do" })] } },
      "- rules added:\n  - loop (`do`) (L9)\n",
    ],
    [
      "a modified loop with no base to set beside it by its new kind",
      { rules: { ...none(), modified: [rule({ type: "loop", line: 3, loopKind: "while" })] } },
      "- rules modified:\n  - loop (`while`) (L3)\n",
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
      "an added effect by id, target, line and plugin",
      {
        effects: {
          ...none(),
          added: [
            { id: "db.write", target: "prisma.user.create", line: 42, plugin: "effects-prisma" },
          ],
        },
      },
      "- effects added:\n  - db.write: `prisma.user.create` (L42) [effects-prisma]\n",
    ],
    [
      "a removed effect with its confidence badge",
      {
        effects: {
          ...none(),
          removed: [
            effect({
              id: "event.publish",
              target: "bus.emit",
              plugin: "effects-nest",
              line: 3,
              confidence: "medium",
            }),
          ],
        },
      },
      "- effects removed:\n  - event.publish: `bus.emit` (L3) [effects-nest] ⚠ medium\n",
    ],
    [
      "an effect whose confidence was downgraded, with no base to set beside it, by its badge",
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
      "- effects modified:\n  - db.write: `prisma.user.create` (L7) [effects-prisma] ⚠ low\n",
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
      "- effects modified:\n  - db.write: `prisma.user.create` [propagated from `ts:src/repository.ts#Repository.save`] [effects-prisma]\n",
    ],
    [
      "a removed call by target and line",
      {
        calls: {
          ...none(),
          removed: [{ target: "helper.doWork", line: 8, resolved: "ts:src/helper.ts#doWork" }],
        },
      },
      "- calls removed:\n  - `helper.doWork` (L8)\n",
    ],
    [
      "a call that stopped resolving, with no base to set beside it, by what it resolves to",
      { calls: { ...none(), modified: [{ target: "useInvoices", line: 15, resolved: null }] } },
      "- calls modified:\n  - `useInvoices` (L15) resolved: none\n",
    ],
  ])("names %s", (_, flags, rows) => {
    expect(renderDelta(flags)).toContain(rows)
  })
})

describe("a modified element's row beside the base element the diff paired it with", () => {
  const userCreate = (overrides: Partial<Parameters<typeof effect>[0]> = {}) =>
    effect({ id: "db.write", target: "prisma.user.create", plugin: "effects-prisma", ...overrides })
  const loop = (line: number, loopKind: "for" | "while" | "do") =>
    rule({ type: "loop", line, loopKind })
  const guard = (line: number, condition: string) => rule({ type: "guard", line, condition })

  type Case = [string, SymbolArrays, Partial<IRSymbol>, Partial<SymbolDelta>, string]

  it.each<Case>([
    [
      "a loop's old kind before its new one",
      { rules: [loop(3, "for")] },
      { rules: [loop(3, "while")] },
      { rules: { ...none(), modified: [loop(3, "while")] } },
      "- rules modified:\n  - loop (`for` → `while`) (L3)\n",
    ],
    [
      "the old kind of a loop that moved, and its new line alone",
      { rules: [loop(3, "for")] },
      { rules: [loop(4, "while")] },
      { rules: { ...none(), modified: [loop(4, "while")] } },
      "- rules modified:\n  - loop (`for` → `while`) (L4)\n",
    ],
    [
      "a guard's old condition before its new one",
      { rules: [guard(4, "!data.name")] },
      { rules: [guard(4, "!data.name || data.name.length > 64")] },
      { rules: { ...none(), modified: [guard(4, "!data.name || data.name.length > 64")] } },
      "- rules modified:\n  - guard: `!data.name` → `!data.name || data.name.length > 64` (L4)\n",
    ],
    [
      "what a throw threw before",
      { rules: [rule({ type: "throw", line: 5, what: "new NotFound()" })] },
      { rules: [rule({ type: "throw", line: 5, what: "new Gone()" })] },
      { rules: { ...none(), modified: [rule({ type: "throw", line: 5, what: "new Gone()" })] } },
      "- rules modified:\n  - throw: `new NotFound()` → `new Gone()` (L5)\n",
    ],
    [
      "what a return returned before",
      { rules: [rule({ type: "return", line: 7, expr: "user" })] },
      { rules: [rule({ type: "return", line: 7, expr: "{ ...user, id }" })] },
      {
        rules: {
          ...none(),
          modified: [rule({ type: "return", line: 7, expr: "{ ...user, id }" })],
        },
      },
      "- rules modified:\n  - return: `user` → `{ ...user, id }` (L7)\n",
    ],
    [
      "the value a return no longer returns",
      { rules: [rule({ type: "return", line: 7, expr: "user" })] },
      { rules: [rule({ type: "return", line: 7 })] },
      { rules: { ...none(), modified: [rule({ type: "return", line: 7 })] } },
      "- rules modified:\n  - return: `user` → none (L7)\n",
    ],
    [
      "an effect's old confidence after its new badge",
      { effects: [userCreate({ line: 5 })] },
      { effects: [userCreate({ line: 5, confidence: "medium" })] },
      { effects: { ...none(), modified: [userCreate({ line: 5, confidence: "medium" })] } },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium (was high)\n",
    ],
    [
      "the badge an effect lost when its confidence rose",
      { effects: [userCreate({ line: 5, confidence: "medium" })] },
      { effects: [userCreate({ line: 5 })] },
      { effects: { ...none(), modified: [userCreate({ line: 5 })] } },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-prisma] (was ⚠ medium)\n",
    ],
    [
      "an effect's old plugin before its new one",
      { effects: [userCreate({ line: 5, plugin: "effects-drizzle" })] },
      { effects: [userCreate({ line: 5 })] },
      { effects: { ...none(), modified: [userCreate({ line: 5 })] } },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-drizzle → effects-prisma]\n",
    ],
    [
      "the plugin a head effect without one had",
      { effects: [userCreate({ line: 5 })] },
      { effects: [lacking(userCreate({ line: 5 }), "plugin")] },
      { effects: { ...none(), modified: [lacking(userCreate({ line: 5 }), "plugin")] } },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-prisma → none]\n",
    ],
    [
      "a propagated effect's old sources before its new ones",
      { effects: [userCreate({ propagated: true, derivedFrom: ["ts:src/a.ts#a"] })] },
      {
        effects: [
          userCreate({ propagated: true, derivedFrom: ["ts:src/a.ts#a", "ts:src/b.ts#b"] }),
        ],
      },
      {
        effects: {
          ...none(),
          modified: [
            userCreate({ propagated: true, derivedFrom: ["ts:src/a.ts#a", "ts:src/b.ts#b"] }),
          ],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` [propagated from `ts:src/a.ts#a`] → [propagated from `ts:src/a.ts#a`, `ts:src/b.ts#b`] [effects-prisma]\n",
    ],
    [
      "the line of a local effect that is now propagated",
      { effects: [userCreate({ line: 5 })] },
      { effects: [userCreate({ propagated: true, derivedFrom: ["ts:src/a.ts#a"] })] },
      {
        effects: {
          ...none(),
          modified: [userCreate({ propagated: true, derivedFrom: ["ts:src/a.ts#a"] })],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) → [propagated from `ts:src/a.ts#a`] [effects-prisma]\n",
    ],
    [
      "a call's old resolution before its new one",
      {
        calls: [call({ target: "useInvoices", line: 15, resolved: "ts:src/hooks.ts#useInvoices" })],
      },
      { calls: [call({ target: "useInvoices", line: 15 })] },
      { calls: { ...none(), modified: [call({ target: "useInvoices", line: 15 })] } },
      "- calls modified:\n  - `useInvoices` (L15) resolved: `ts:src/hooks.ts#useInvoices` → none\n",
    ],
    [
      "a decorator's old arguments, each side as written",
      {
        decorators: [
          decorator({ name: "UseGuards", raw: "UseGuards(AuthGuard)", arguments: ["AuthGuard"] }),
        ],
      },
      {
        decorators: [
          decorator({
            name: "UseGuards",
            raw: "UseGuards(AuthGuard, RoleGuard)",
            arguments: ["AuthGuard", "RoleGuard"],
          }),
        ],
      },
      {
        decorators: {
          ...none(),
          modified: [
            decorator({
              name: "UseGuards",
              raw: "UseGuards(AuthGuard, RoleGuard)",
              arguments: ["AuthGuard", "RoleGuard"],
            }),
          ],
        },
      },
      "- decorator modified: `@UseGuards(AuthGuard)` → `@UseGuards(AuthGuard, RoleGuard)`\n",
    ],
    [
      "a decorator's old receiver",
      { decorators: [decorator({ name: "Post", qualifier: "nest" })] },
      { decorators: [decorator({ name: "Post" })] },
      { decorators: { ...none(), modified: [decorator({ name: "Post" })] } },
      "- decorator modified: `@nest.Post()` → `@Post()`\n",
    ],
    [
      "an input's old type before its new one",
      { signature: sig({ inputs: [{ name: "id", type: "string" }] }) },
      { signature: sig({ inputs: [{ name: "id", type: "number" }] }) },
      {
        signature: signature({ inputs: { ...none(), modified: [{ name: "id", type: "number" }] } }),
      },
      "- signature.inputs modified: `id: string` → `id: number`\n",
    ],
    [
      "an input that turned optional",
      {
        signature: sig({
          inputs: [
            { name: "id", type: "string" },
            { name: "limit", type: "number" },
          ],
        }),
      },
      {
        signature: sig({
          inputs: [
            { name: "id", type: "string" },
            { name: "limit", type: "number", optional: true },
          ],
        }),
      },
      {
        signature: signature({
          inputs: { ...none(), modified: [{ name: "limit", type: "number", optional: true }] },
        }),
      },
      "- signature.inputs modified: `limit: number` → `limit?: number`\n",
    ],
    [
      "the loop it replaced, beside a removed loop of another kind",
      { rules: [loop(3, "for"), loop(7, "do")] },
      { rules: [loop(5, "while")] },
      { rules: { added: [], removed: [loop(7, "do")], modified: [loop(5, "while")] } },
      "- rules modified:\n  - loop (`for` → `while`) (L5)\n",
    ],
    [
      "the effect it replaced, beside a removed effect",
      {
        effects: [
          userCreate({ line: 3, plugin: "effects-drizzle" }),
          userCreate({ line: 9, plugin: "effects-drizzle", confidence: "low" }),
        ],
      },
      { effects: [userCreate({ line: 5, confidence: "medium" })] },
      {
        effects: {
          added: [],
          removed: [userCreate({ line: 9, plugin: "effects-drizzle", confidence: "low" })],
          modified: [userCreate({ line: 5, confidence: "medium" })],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-drizzle → effects-prisma] ⚠ medium (was high)\n",
    ],
    [
      "an effect's old confidence, beside an unchanged effect of another plugin",
      {
        effects: [
          userCreate({ line: 3, confidence: "low" }),
          userCreate({ line: 9, plugin: "effects-drizzle", confidence: "medium" }),
        ],
      },
      {
        effects: [
          userCreate({ line: 5, confidence: "medium" }),
          userCreate({ line: 9, plugin: "effects-drizzle", confidence: "medium" }),
        ],
      },
      { effects: { ...none(), modified: [userCreate({ line: 5, confidence: "medium" })] } },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium (was ⚠ low)\n",
    ],
    [
      "a guard's old condition, beside an unchanged guard that had the same one",
      { rules: [guard(3, "a"), guard(10, "a")] },
      { rules: [guard(3, "a"), guard(10, "c")] },
      { rules: { ...none(), modified: [guard(10, "c")] } },
      "- rules modified:\n  - guard: `a` → `c` (L10)\n",
    ],
    [
      "an effect's old confidence, not that of the base effect equal to it that another took",
      {
        effects: [
          userCreate({ line: 1 }),
          userCreate({ line: 2, confidence: "medium" }),
          userCreate({ line: 3, confidence: "low" }),
        ],
      },
      {
        effects: [
          userCreate({ line: 1, plugin: "effects-drizzle" }),
          userCreate({ line: 2, confidence: "medium" }),
          userCreate({ line: 3 }),
        ],
      },
      {
        effects: {
          ...none(),
          modified: [userCreate({ line: 1, plugin: "effects-drizzle" }), userCreate({ line: 3 })],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` (L1) [effects-prisma → effects-drizzle]\n  - db.write: `prisma.user.create` (L3) [effects-prisma] (was ⚠ low)\n",
    ],
  ])("writes %s", (_, before, after, flags, row) => {
    expect(renderDelta(flags, before, after)).toContain(row)
  })

  it.each<Case>([
    [
      "a line or derivedBy, which the diff does not compare",
      { effects: [userCreate({ line: 9, derivedBy: "convention:a" })] },
      { effects: [userCreate({ line: 5, derivedBy: "convention:b", confidence: "medium" })] },
      {
        effects: {
          ...none(),
          modified: [userCreate({ line: 5, derivedBy: "convention:b", confidence: "medium" })],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium (was high)\n",
    ],
    [
      "a base element equal to the head one, which an unchanged element was paired with",
      { rules: [loop(3, "for"), loop(8, "while")] },
      { rules: [loop(3, "while"), loop(8, "while")] },
      { rules: { ...none(), modified: [loop(3, "while")] } },
      "- rules modified:\n  - loop (`for` → `while`) (L3)\n",
    ],
    [
      "a base element under another key",
      {
        effects: [
          userCreate({ line: 5 }),
          userCreate({
            target: "prisma.post.create",
            line: 6,
            plugin: "effects-drizzle",
            confidence: "low",
          }),
        ],
      },
      {
        effects: [
          userCreate({ line: 5, confidence: "medium" }),
          userCreate({
            target: "prisma.post.create",
            line: 6,
            plugin: "effects-drizzle",
            confidence: "low",
          }),
        ],
      },
      { effects: { ...none(), modified: [userCreate({ line: 5, confidence: "medium" })] } },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium (was high)\n",
    ],
    [
      "a base effect with no confidence, which no unchanged effect at high equals",
      { effects: [userCreate({ line: 3 }), lacking(userCreate({ line: 9 }), "confidence")] },
      { effects: [userCreate({ line: 3 }), userCreate({ line: 9, confidence: "low" })] },
      { effects: { ...none(), modified: [userCreate({ line: 9, confidence: "low" })] } },
      "- effects modified:\n  - db.write: `prisma.user.create` (L9) [effects-prisma] ⚠ low\n",
    ],
    [
      "a base Symbol holding an effect it cannot read, which either could have been paired with",
      {
        effects: [
          userCreate({ propagated: true, derivedFrom: [] }),
          userCreate({ line: 9, plugin: "effects-drizzle", confidence: "low" }),
        ],
      },
      {
        effects: [
          userCreate({ line: 5, confidence: "medium" }),
          userCreate({ line: 9, confidence: "low" }),
        ],
      },
      {
        effects: {
          ...none(),
          modified: [
            userCreate({ line: 5, confidence: "medium" }),
            userCreate({ line: 9, confidence: "low" }),
          ],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium\n  - db.write: `prisma.user.create` (L9) [effects-prisma] ⚠ low\n",
    ],
  ])("takes no base value from %s", (_, before, after, flags, row) => {
    expect(renderDelta(flags, before, after)).toContain(row)
  })

  it.each<Case>([
    [
      "two edited guards whose old conditions differ",
      { rules: [guard(3, "a"), guard(10, "b")] },
      { rules: [guard(3, "c"), guard(10, "d")] },
      { rules: { ...none(), modified: [guard(3, "c"), guard(10, "d")] } },
      "- rules modified:\n  - guard: `c` (L3)\n  - guard: `d` (L10)\n",
    ],
    [
      "two edited effects, on a field one of their bases shares with it or the two disagree on",
      {
        effects: [
          userCreate({ line: 3, confidence: "low" }),
          userCreate({ line: 9, plugin: "effects-drizzle", confidence: "medium" }),
        ],
      },
      {
        effects: [
          userCreate({ line: 5, confidence: "medium" }),
          userCreate({ line: 9, plugin: "effects-drizzle" }),
        ],
      },
      {
        effects: {
          ...none(),
          modified: [
            userCreate({ line: 5, confidence: "medium" }),
            userCreate({ line: 9, plugin: "effects-drizzle" }),
          ],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium\n  - db.write: `prisma.user.create` (L9) [effects-drizzle]\n",
    ],
    [
      "the origin of two base effects alike but for their line, one paired with an unchanged effect",
      { effects: [userCreate({ line: 3 }), userCreate({ line: 9 })] },
      {
        effects: [
          userCreate({ line: 3 }),
          userCreate({ propagated: true, derivedFrom: ["ts:src/a.ts#a"] }),
        ],
      },
      {
        effects: {
          ...none(),
          modified: [userCreate({ propagated: true, derivedFrom: ["ts:src/a.ts#a"] })],
        },
      },
      "- effects modified:\n  - db.write: `prisma.user.create` [propagated from `ts:src/a.ts#a`] [effects-prisma]\n",
    ],
    [
      "a decorator whose arguments changed only in their line breaks",
      {
        decorators: [
          decorator({
            name: "Get",
            raw: 'Get({\n  path: "/x"\n})',
            arguments: ['{\n  path: "/x"\n}'],
          }),
        ],
      },
      {
        decorators: [
          decorator({ name: "Get", raw: 'Get({ path: "/x" })', arguments: ['{ path: "/x" }'] }),
        ],
      },
      {
        decorators: {
          ...none(),
          modified: [
            decorator({ name: "Get", raw: 'Get({ path: "/x" })', arguments: ['{ path: "/x" }'] }),
          ],
        },
      },
      '- decorator modified: `@Get({ path: "/x" })`\n',
    ],
  ])("writes the head value alone for %s", (_, before, after, flags, row) => {
    expect(renderDelta(flags, before, after)).toContain(row)
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
    [
      "a propagated effect with no direct sources",
      {
        effects: {
          ...none(),
          added: [{ id: "db.read", target: "t", propagated: true, derivedFrom: [] }],
        },
      },
      "effects added",
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
  it("sets each base value before the head one, the confidence row last", () => {
    const md = projectChanges([
      changed(
        namedSymbol("Foo", { component: "framework-express", visibility: "internal" }),
        {
          apiChanged: true,
          componentChanged: true,
          visibilityChanged: true,
          confidenceChanged: true,
        },
        { component: componentId("core"), visibility: "public", confidence: "low" },
      ),
    ])
    expect(md).toContain(
      "- component: `framework-express` → `core`\n- visibility: `internal` → `public`\n- confidence: `high` → `low`\n",
    )
  })

  it.each<[string, string | null, string | null, string]>([
    ["joined one", null, "billing", "- component: none → `billing`\n"],
    ["left every one", "billing", null, "- component: `billing` → none\n"],
  ])("names no Component for a Symbol that %s", (_, from, to, row) => {
    const md = projectChanges([
      changed(
        namedSymbol("Foo", { component: from }),
        { logicChanged: true, componentChanged: true },
        { component: to === null ? null : componentId(to) },
      ),
    ])
    expect(md).toContain(row)
  })
})

describe("the name row of a pair whose name changed", () => {
  it.each([
    ["between files", "parseAmount", "src/parse.ts", "readAmount", "src/amount.ts"],
    ["within one file", "convertCurrency", "src/money.ts", "convertCurrencyAmount", "src/money.ts"],
  ])("opens the delta body, on a rename %s", (_, from, fromFile, to, toFile) => {
    const md = projectChanges([renamedPair(from, fromFile, to, toFile)])
    expect(md).toContain(`**Delta**:\n- name: \`${from}\` → \`${to}\`\n`)
  })

  it("comes before the signature rows in both bodies, the API entry titled by its new name", () => {
    const md = projectChanges([
      renamedPair("parseAmount", "src/parse.ts", "readAmount", "src/amount.ts", {
        apiChanged: true,
        signature: signature({ outputs: { added: ["number"], removed: ["string"], modified: [] } }),
      }),
    ])
    const rows = "- name: `parseAmount` → `readAmount`\n- signature.outputs: `string` → `number`\n"
    expect(md).toContain(`**Delta**:\n${rows}`)
    expect(sectionOf(md, "## ⚠ API changes").join("\n")).toContain(
      `### \`readAmount\` *(function)*\n**File**: \`src/amount.ts:1\`\n\n${rows}`,
    )
  })
})
