import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { DOCUMENT_SHAPE } from "../src/integrity-shape"

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
    const { defs } = await loadSchema()
    const structural = Object.entries(defs)
      .filter(([, node]) => node.properties !== undefined)
      .map(([name]) => name)
    expect(structural.filter((name) => !(name in DOCUMENT_SHAPE))).toEqual([])
  })
})
