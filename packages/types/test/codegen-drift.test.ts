import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ENTRIES, generateAll, OUT_DIR, readDefNames } from "../scripts/codegen-lib"

describe("schema codegen", () => {
  it("committed generated files match what codegen would produce now", async () => {
    const expected = await generateAll()
    for (const entry of ENTRIES) {
      const path = join(OUT_DIR, entry.out)
      const actual = await readFile(path, "utf8")
      expect(actual, `${entry.out} is out of date. Run: pnpm --filter @aburi/types codegen`).toBe(
        expected[entry.out],
      )
    }
  })

  it("is deterministic (running twice produces identical output)", async () => {
    const a = await generateAll()
    const b = await generateAll()
    expect(b).toEqual(a)
  })

  // The equality check above only catches drift -- it cannot detect a regression where
  // codegen and committed file both end up in the same broken state (e.g. json-schema-to-typescript
  // changes its output and rewriteCrossRefs silently misses a placeholder). The structural
  // assertions below codify the post-conditions that crossRef + intersection-strip must hold.

  it("diff.ts has no empty placeholder interfaces left over from cross-ref rewrite", async () => {
    const generated = await generateAll()
    const diff = generated["diff.ts"]
    expect(diff).toBeDefined()
    // If rewriteCrossRefs misses a Symbol/Component/Dependency placeholder, we get a local
    // `interface Symbol {}` colliding with the re-exported one from ./ir.
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
    // `({\n[k: string]: unknown | undefined\n} & {...})` defeats noUncheckedIndexedAccess and lets
    // consumers add undeclared keys. stripPermissiveIntersection must clear it for every entry.
    const generated = await generateAll()
    const wrapper = /\(\{\s*\[k: string\]: unknown \| undefined\s*\} & \{/
    for (const entry of ENTRIES) {
      const body = generated[entry.out]
      expect(body, `${entry.out} content missing`).toBeDefined()
      expect(body, `${entry.out} still contains the JST permissive wrapper`).not.toMatch(wrapper)
    }
  })

  it("crossRef rewrite fails loudly when its placeholder is not found exactly once", async () => {
    const { rewriteCrossRefsForTest } = await import("../scripts/codegen-lib")
    // Zero matches -> error
    expect(() =>
      rewriteCrossRefsForTest("synthetic.json", "no placeholder here", { Foo: "./x" }),
    ).toThrowError(/expected exactly 1 loose placeholder.*Foo/)
    // Two matches -> error
    expect(() =>
      rewriteCrossRefsForTest(
        "synthetic.json",
        "export interface Foo {\n}\nexport interface Foo {\n}\n",
        { Foo: "./x" },
      ),
    ).toThrowError(/expected exactly 1 loose placeholder.*Foo/)
  })

  it("crossRef rewrite strips string-alias placeholders as well as object ones", async () => {
    const { rewriteCrossRefsForTest } = await import("../scripts/codegen-lib")
    // A `$def` of `{"type": "string"}` lands as a type alias, not an empty interface. The
    // diff schema's SymbolId is exactly that shape and must still be re-exported from ./ir.
    const out = rewriteCrossRefsForTest(
      "synthetic.json",
      "export type Foo = string\nexport interface Bar {\n}\n",
      { Foo: "./x", Bar: "./x" },
    )
    expect(out).not.toMatch(/export type Foo = string/)
    expect(out).not.toMatch(/export interface Bar/)
    expect(out).toMatch(/import type \{ Bar, Foo \} from "\.\/x"/)
  })

  // The brand pass is what turns `SymbolId` / `ComponentId` / `SliceId` from interchangeable
  // string aliases into separate namespaces. The equality check at the top of this file cannot
  // notice if it silently stops firing -- codegen and the committed file would go unbranded
  // together -- so the post-conditions are asserted directly.

  it("every id that owns a namespace is generated as a nominal type", async () => {
    const generated = await generateAll()
    const branded: Record<string, string> = {
      "ir.ts": "SymbolId",
      "diff.ts": "SliceId",
    }
    for (const [file, name] of Object.entries(branded)) {
      const body = generated[file]
      expect(body, `${file} content missing`).toBeDefined()
      expect(body).toContain(`export type ${name} = string & { readonly __brand: "${name}" }`)
    }
    expect(generated["ir.ts"]).toContain(
      'export type ComponentId = string & { readonly __brand: "ComponentId" }',
    )
  })

  it("no id alias is left as a bare string", async () => {
    const generated = await generateAll()
    // A bare `= string` here means the alias override silently missed: the type would still
    // compile everywhere, and every accidental cross-assignment would still be accepted.
    for (const name of ["SymbolId", "ComponentId"]) {
      expect(generated["ir.ts"], `ir.ts leaves ${name} unbranded`).not.toMatch(
        new RegExp(`^export type ${name} = string$`, "m"),
      )
    }
    expect(generated["diff.ts"], "diff.ts leaves SliceId unbranded").not.toMatch(
      /^export type SliceId = string$/m,
    )
  })

  it("Dependency endpoints are the union of the two id kinds, not a string", async () => {
    const generated = await generateAll()
    expect(generated["ir.ts"]).toContain("export type DependencyEndpoint = SymbolId | ComponentId")
    expect(generated["ir.ts"]).toMatch(/^from: DependencyEndpoint$/m)
    expect(generated["ir.ts"]).toMatch(/^to: DependencyEndpoint$/m)
  })

  it("diff.ts re-exports SymbolId from ./ir instead of declaring its own", async () => {
    const generated = await generateAll()
    const diff = generated["diff.ts"]
    expect(diff).toBeDefined()
    // A local alias here would shadow the branded one and make SliceRecord.members
    // structurally compatible with any string array again.
    expect(diff).not.toMatch(/^export type SymbolId =/m)
    expect(diff).toMatch(/import type \{[^}]*SymbolId[^}]*\} from "\.\/ir"/)
    expect(diff).toMatch(/export type \{[^}]*SymbolId[^}]*\} from "\.\/ir"/)
    expect(diff).toMatch(/^members: SymbolId\[\]$/m)
    expect(diff).toMatch(/^id: SliceId$/m)
  })

  it("every id-shaped $def is accounted for by the brand table", async () => {
    // The equality check cannot see this one either: add `$defs.TenantId` to a schema,
    // forget to touch ENTRIES, and codegen emits `export type TenantId = string` into a
    // committed file that also says `= string`. Both sides agree and the drift test passes,
    // while the new id silently joins the set of interchangeable strings.
    for (const entry of ENTRIES) {
      const defs = await readDefNames(entry.schema)
      const accountedFor = new Set([
        ...Object.keys(entry.aliasOverrides ?? {}),
        ...Object.keys(entry.crossRefs ?? {}),
        ...(entry.unbrandedIds ?? []),
      ])
      for (const name of defs.filter((d) => d.endsWith("Id"))) {
        expect(
          accountedFor.has(name),
          `${entry.schema} declares $defs.${name}, which is not in aliasOverrides, crossRefs, ` +
            `or unbrandedIds. Decide whether it owns a namespace and say so in ENTRIES.`,
        ).toBe(true)
      }
    }
  })

  it("alias override fails loudly when its target is not found exactly once", async () => {
    const { applyAliasOverridesForTest } = await import("../scripts/codegen-lib")
    expect(() =>
      applyAliasOverridesForTest("synthetic.json", "no alias here", { Foo: "string & {}" }),
    ).toThrowError(/expected exactly 1 `export type Foo = string`.*found 0/s)
    expect(() =>
      applyAliasOverridesForTest(
        "synthetic.json",
        "export type Foo = string\nexport type Foo = string\n",
        { Foo: "string & {}" },
      ),
    ).toThrowError(/expected exactly 1 `export type Foo = string`.*found 2/s)
  })
})
