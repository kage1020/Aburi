import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ENTRIES, generateAll, OUT_DIR } from "../scripts/codegen-lib"

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
    ).toThrowError(/expected exactly 1 empty placeholder.*Foo/)
    // Two matches -> error
    expect(() =>
      rewriteCrossRefsForTest(
        "synthetic.json",
        "export interface Foo {\n}\nexport interface Foo {\n}\n",
        { Foo: "./x" },
      ),
    ).toThrowError(/expected exactly 1 empty placeholder.*Foo/)
  })
})
