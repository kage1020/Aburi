import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SCHEMA_DIR } from "../scripts/codegen-lib"

interface SchemaNode {
  $ref?: string
  description?: string
  type?: string | string[]
  oneOf?: SchemaNode[]
  anyOf?: SchemaNode[]
  allOf?: SchemaNode[]
  required?: string[]
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  $defs?: Record<string, SchemaNode>
}

interface OptionalProperty {
  /** Dotted path from the document root, e.g. `SourceRange.startColumn`. */
  path: string
  property: SchemaNode
}

async function readIrSchema(): Promise<SchemaNode> {
  const raw = await readFile(join(SCHEMA_DIR, "aburi.ir.v1.json"), "utf8")
  return JSON.parse(raw) as SchemaNode
}

function optionalProperties(schema: SchemaNode): OptionalProperty[] {
  const out: OptionalProperty[] = []
  const seen = new Set<SchemaNode>()

  const visit = (owner: string, node: SchemaNode | undefined): void => {
    if (node === undefined || seen.has(node)) return
    seen.add(node)
    const required = new Set(node.required ?? [])
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      const path = `${owner}.${name}`
      if (!required.has(name)) out.push({ path, property })
      visit(path, property)
    }
    visit(`${owner}[]`, node.items)
    for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])]) {
      visit(owner, branch)
    }
  }

  visit("(root)", schema)
  for (const [defName, def] of Object.entries(schema.$defs ?? {})) visit(defName, def)
  return out
}

function admitsNull(node: SchemaNode, defs: Record<string, SchemaNode>): boolean {
  const resolved = node.$ref !== undefined ? defs[node.$ref.replace("#/$defs/", "")] : undefined
  if (resolved !== undefined && admitsNull(resolved, {})) return true
  if (node.type === "null") return true
  if (Array.isArray(node.type) && node.type.includes("null")) return true
  return [...(node.oneOf ?? []), ...(node.anyOf ?? [])].some((branch) => admitsNull(branch, defs))
}

describe("aburi.ir.v1 optional-property conventions (ir-schema.md)", () => {
  it("every optional property declares its absent-vs-null convention in `description`", async () => {
    const undeclared = optionalProperties(await readIrSchema())
      .filter(({ property }) => (property.description ?? "").trim() === "")
      .map(({ path }) => path)

    expect(
      undeclared,
      "Optional properties must state which class of ir-schema.md they belong to: " +
        "Class A (nullable — writers always emit the key, carrying null) or " +
        "Class B (non-nullable — writers omit the key entirely). Add it to the property's " +
        "`description` in schema/aburi.ir.v1.json and to the Class A / Class B table of " +
        "ir-schema.md.",
    ).toEqual([])
  })

  it("the declared class agrees with the declared type", async () => {
    const schema = await readIrSchema()
    const defs = schema.$defs ?? {}
    const mismatches = optionalProperties(schema).flatMap(({ path, property }) => {
      const description = property.description ?? ""
      const nullable = admitsNull(property, defs)
      const claimsA = description.includes("Class A")
      const claimsB = description.includes("Class B")
      if (claimsA && claimsB) return [`${path}: claims both classes`]
      if (nullable && !claimsA) return [`${path}: nullable, so it must be Class A`]
      if (!nullable && !claimsB) return [`${path}: non-nullable, so it must be Class B`]
      return []
    })

    expect(mismatches).toEqual([])
  })

  it("resolves a nullable `$def` reached through `$ref`", async () => {
    const schema = await readIrSchema()
    const defs = schema.$defs ?? {}
    expect(defs.ExtKind, "ExtKind is the standing nullable $def this relies on").toBeDefined()
    expect(admitsNull({ $ref: "#/$defs/ExtKind" }, defs)).toBe(true)
    expect(admitsNull({ $ref: "#/$defs/SymbolId" }, defs)).toBe(false)
  })
})
