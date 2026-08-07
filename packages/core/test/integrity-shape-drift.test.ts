import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { DOCUMENT_SHAPE } from "../src/integrity-shape"

/**
 * Invariant #20 restates the frozen schema's structural requirements in TypeScript, because
 * nothing in the pipeline runs a schema validator and a Document read off disk has to be
 * checked by something. A restatement is a second source of truth, and this is what keeps
 * the two from disagreeing: the schema file is read here, and a `required` entry with no
 * line in the spec fails.
 *
 * The direction matters. The spec is allowed to carry *more* than the schema requires — the
 * schema's optional-but-Class-A fields are checked when present — but never less, because
 * `readIR` brands its result `IR` on the strength of this check alone.
 */

interface SchemaNode {
  required?: string[]
  properties?: Record<string, unknown>
}

async function loadSchema(): Promise<{ root: SchemaNode; defs: Record<string, SchemaNode> }> {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(here, "..", "..", "..")
  const raw = await readFile(resolve(repoRoot, "schema", "aburi.ir.v1.json"), "utf8")
  const parsed = JSON.parse(raw) as SchemaNode & { $defs?: Record<string, SchemaNode> }
  return { root: parsed, defs: parsed.$defs ?? {} }
}

describe("invariant #20 against schema/aburi.ir.v1.json", () => {
  it("covers every required field of every definition it claims to describe", async () => {
    const { root, defs } = await loadSchema()
    const missing: string[] = []
    for (const [name, spec] of Object.entries(DOCUMENT_SHAPE)) {
      const node = name === "$" ? root : defs[name]
      expect(node, `schema has no definition named "${name}"`).toBeDefined()
      for (const field of node?.required ?? []) {
        if (field in spec) continue
        missing.push(`${name}.${field}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("describes no field the schema does not declare", async () => {
    // The other direction: a typo in the spec would silently check a field that never
    // exists, reporting every valid Document as missing it.
    const { root, defs } = await loadSchema()
    const unknown: string[] = []
    for (const [name, spec] of Object.entries(DOCUMENT_SHAPE)) {
      const node = name === "$" ? root : defs[name]
      const properties = node?.properties ?? {}
      for (const field of Object.keys(spec)) {
        if (field in properties) continue
        unknown.push(`${name}.${field}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it("names every definition the Document can reach", async () => {
    // A definition the schema declares but the spec omits is a record #20 walks past. The
    // exceptions are the two id/scalar aliases, which have no `properties` of their own.
    const { defs } = await loadSchema()
    const structural = Object.entries(defs)
      .filter(([, node]) => node.properties !== undefined)
      .map(([name]) => name)
    expect(structural.filter((name) => !(name in DOCUMENT_SHAPE))).toEqual([])
  })
})
