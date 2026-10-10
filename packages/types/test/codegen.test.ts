import { beforeAll, describe, expect, it } from "vitest"
import {
  applyAliasOverrides,
  assertIdsAccountedFor,
  ENTRIES,
  generateAll,
  rewriteCrossRefs,
} from "../scripts/codegen-lib"

describe("generateAll", () => {
  let generated: Record<string, string>
  beforeAll(async () => {
    generated = await generateAll()
  })

  it("is deterministic (running twice produces identical output)", async () => {
    expect(await generateAll()).toEqual(generated)
  })

  it("re-exports diff.ts's cross-referenced types from ./ir instead of declaring placeholders", () => {
    const diff = generated["diff.ts"]
    for (const name of ["Symbol", "Component", "Dependency"]) {
      expect(diff).not.toMatch(new RegExp(String.raw`export interface ${name}\s*\{\s*\}`))
    }
    expect(diff).toMatch(/import type \{[^}]*Symbol[^}]*\} from "\.\/ir"/)
    expect(diff).toMatch(/export type \{[^}]*Symbol[^}]*\} from "\.\/ir"/)
  })

  it("leaks the JST permissive wrapper into no generated file", () => {
    const wrapper = /\(\{\s*\[k: string\]: unknown \| undefined\s*\} & \{/
    for (const entry of ENTRIES) {
      expect(generated[entry.out], entry.out).toBeDefined()
      expect(generated[entry.out], entry.out).not.toMatch(wrapper)
    }
  })
})

describe("rewriteCrossRefs", () => {
  it.each([
    ["is missing", "no placeholder here"],
    ["appears twice", "export interface Foo {\n}\nexport interface Foo {\n}\n"],
  ])("fails loudly when the placeholder %s", (_, body) => {
    expect(() => rewriteCrossRefs("synthetic.json", body, { Foo: "./x" })).toThrowError(
      /expected exactly 1 loose placeholder.*Foo/,
    )
  })

  it("strips string-alias placeholders as well as object ones", () => {
    const out = rewriteCrossRefs(
      "synthetic.json",
      "export type Foo = string\nexport interface Bar {\n}\n",
      { Foo: "./x", Bar: "./x" },
    )
    expect(out).not.toMatch(/export type Foo = string/)
    expect(out).not.toMatch(/export interface Bar/)
    expect(out).toMatch(/import type \{ Bar, Foo \} from "\.\/x"/)
  })

  it("strips a placeholder's own JSDoc without reaching back into the definition before it", () => {
    const body =
      "/**\n * Root.\n */\nexport interface Root {\nx: string\n}\n" +
      "/**\n * Loose.\n */\nexport interface Foo {\n}\n"
    expect(rewriteCrossRefs("synthetic.json", body, { Foo: "./x" })).toBe(
      'import type { Foo } from "./x"\nexport type { Foo } from "./x"\n' +
        "/**\n * Root.\n */\nexport interface Root {\nx: string\n}\n",
    )
  })
})

describe("applyAliasOverrides", () => {
  it.each([
    ["is missing", "no alias here", 0],
    ["appears twice", "export type Foo = string\nexport type Foo = string\n", 2],
  ])("fails loudly when its target %s", (_, body, found) => {
    expect(() => applyAliasOverrides("synthetic.json", body, { Foo: "string & {}" })).toThrowError(
      new RegExp(`expected exactly 1 \`export type Foo = string\`.*found ${found}`, "s"),
    )
  })

  it("writes the replacement literally, `$&` included", () => {
    expect(
      applyAliasOverrides("synthetic.json", "export type Foo = string\n", { Foo: "`$&` & string" }),
    ).toBe("export type Foo = `$&` & string\n")
  })
})

describe("assertIdsAccountedFor", () => {
  const entry = {
    schema: "synthetic.json",
    out: "synthetic.ts",
    rootName: "Synthetic",
    aliasOverrides: { SymbolId: "string & {}" },
    crossRefs: { SliceId: "./ir" },
    unbrandedIds: ["EffectId"],
  }

  it("accepts an id $def the entry brands, re-exports or lists as unbranded", () => {
    const schema = { $defs: { SymbolId: {}, SliceId: {}, EffectId: {}, Name: {} } }
    expect(() => assertIdsAccountedFor(entry, schema)).not.toThrow()
  })

  it("refuses an id $def the entry says nothing about, naming it", () => {
    const schema = { $defs: { SymbolId: {}, TicketId: {}, Name: {} } }
    expect(() => assertIdsAccountedFor(entry, schema)).toThrowError(
      /^synthetic\.json declares \$defs\.TicketId, /,
    )
  })
})
