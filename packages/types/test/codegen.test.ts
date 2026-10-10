import { describe, expect, it } from "vitest"
import { applyAliasOverrides, ENTRIES, generateAll, rewriteCrossRefs } from "../scripts/codegen-lib"

describe("schema codegen", () => {
  it("is deterministic (running twice produces identical output)", async () => {
    const a = await generateAll()
    const b = await generateAll()
    expect(b).toEqual(a)
  })

  it("diff.ts has no empty placeholder interfaces left over from cross-ref rewrite", async () => {
    const generated = await generateAll()
    const diff = generated["diff.ts"]
    expect(diff).toBeDefined()
    for (const name of ["Symbol", "Component", "Dependency"]) {
      const orphanPattern = new RegExp(String.raw`export interface ${name}\s*\{\s*\}`)
      expect(diff, `diff.ts must not contain placeholder \`interface ${name} {}\``).not.toMatch(
        orphanPattern,
      )
    }
  })

  it("diff.ts re-exports Symbol/Component/Dependency from ./ir", async () => {
    const generated = await generateAll()
    const diff = generated["diff.ts"]
    expect(diff).toBeDefined()
    expect(diff).toMatch(/import type \{[^}]*Symbol[^}]*\} from "\.\/ir"/)
    expect(diff).toMatch(/export type \{[^}]*Symbol[^}]*\} from "\.\/ir"/)
  })

  it("no generated file leaks the JST permissive wrapper", async () => {
    const generated = await generateAll()
    const wrapper = /\(\{\s*\[k: string\]: unknown \| undefined\s*\} & \{/
    for (const entry of ENTRIES) {
      const body = generated[entry.out]
      expect(body, `${entry.out} content missing`).toBeDefined()
      expect(body, `${entry.out} still contains the JST permissive wrapper`).not.toMatch(wrapper)
    }
  })

  it("crossRef rewrite fails loudly when its placeholder is not found exactly once", async () => {
    expect(() =>
      rewriteCrossRefs("synthetic.json", "no placeholder here", { Foo: "./x" }),
    ).toThrowError(/expected exactly 1 loose placeholder.*Foo/)
    expect(() =>
      rewriteCrossRefs("synthetic.json", "export interface Foo {\n}\nexport interface Foo {\n}\n", {
        Foo: "./x",
      }),
    ).toThrowError(/expected exactly 1 loose placeholder.*Foo/)
  })

  it("crossRef rewrite strips string-alias placeholders as well as object ones", async () => {
    const out = rewriteCrossRefs(
      "synthetic.json",
      "export type Foo = string\nexport interface Bar {\n}\n",
      { Foo: "./x", Bar: "./x" },
    )
    expect(out).not.toMatch(/export type Foo = string/)
    expect(out).not.toMatch(/export interface Bar/)
    expect(out).toMatch(/import type \{ Bar, Foo \} from "\.\/x"/)
  })

  it("alias override fails loudly when its target is not found exactly once", () => {
    expect(() =>
      applyAliasOverrides("synthetic.json", "no alias here", { Foo: "string & {}" }),
    ).toThrowError(/expected exactly 1 `export type Foo = string`.*found 0/s)
    expect(() =>
      applyAliasOverrides(
        "synthetic.json",
        "export type Foo = string\nexport type Foo = string\n",
        {
          Foo: "string & {}",
        },
      ),
    ).toThrowError(/expected exactly 1 `export type Foo = string`.*found 2/s)
  })
})
