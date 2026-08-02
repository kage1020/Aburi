import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SCHEMA_DIR } from "../scripts/codegen-lib"

/**
 * `docs/design/ir-schema.md` §1.1 splits every optional IR property into Class A
 * (nullable — the key is always written, carrying `null` when there is no value) and
 * Class B (non-nullable — the key's presence is itself the signal). The split follows
 * mechanically from the declared type, but which one a property means only reaches a
 * writer through its `description`, which codegen lifts into JSDoc on the generated types.
 *
 * The failure this guards against is the one that produced the mixed conventions in the
 * first place: an optional property lands with no stated rule, two writers pick opposite
 * readings, and the ambiguity is only noticed once a reader has to defend against three
 * states. A missing or contradictory `description` is the observable form of "the class
 * was never declared".
 */

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

/**
 * Walk every object node reachable from the root, not just the root and `$defs` — an
 * optional property declared on an inline nested object is exactly as capable of landing
 * without a stated class as a top-level one.
 */
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

/**
 * True when the property admits `null` — inline, through a composition branch, or through a
 * `$ref` to a definition that does. Following the `$ref` matters: `ExtKind` is a nullable
 * `$def`, so a future optional written as a bare `{"$ref": "#/$defs/ExtKind"}` would look
 * non-nullable to a shallow check and get told to declare itself Class B, the opposite of
 * what §1.1 says. Resolution is one hop deep, which covers every `$ref` shape in v1.
 */
function admitsNull(node: SchemaNode, defs: Record<string, SchemaNode>): boolean {
  const resolved = node.$ref !== undefined ? defs[node.$ref.replace("#/$defs/", "")] : undefined
  if (resolved !== undefined && admitsNull(resolved, {})) return true
  if (node.type === "null") return true
  if (Array.isArray(node.type) && node.type.includes("null")) return true
  return [...(node.oneOf ?? []), ...(node.anyOf ?? [])].some((branch) => admitsNull(branch, defs))
}

describe("aburi.ir.v1 optional-property conventions (ir-schema.md §1.1)", () => {
  it("every optional property declares its absent-vs-null convention in `description`", async () => {
    const undeclared = optionalProperties(await readIrSchema())
      .filter(({ property }) => (property.description ?? "").trim() === "")
      .map(({ path }) => path)

    expect(
      undeclared,
      "Optional properties must state which class of ir-schema.md §1.1 they belong to: " +
        "Class A (nullable — writers always emit the key, carrying null) or " +
        "Class B (non-nullable — writers omit the key entirely). Add it to the property's " +
        "`description` in schema/aburi.ir.v1.json and to the §1.1 table.",
    ).toEqual([])
  })

  it("the declared class agrees with the declared type", async () => {
    // The two classes are mutually exclusive by construction: a nullable optional is
    // Class A, a non-nullable optional is Class B. Checking the prose against the type
    // is what stops a copy-pasted description from claiming the opposite of what the
    // schema says -- the description is the only copy of the rule a plugin author sees.
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
    // Guards the check above rather than the schema: without `$ref` resolution the helper
    // silently reclassifies, and a reclassification is worse than no check at all because
    // the resulting message tells the author to write the wrong class.
    const schema = await readIrSchema()
    const defs = schema.$defs ?? {}
    expect(defs.ExtKind, "ExtKind is the standing nullable $def this relies on").toBeDefined()
    expect(admitsNull({ $ref: "#/$defs/ExtKind" }, defs)).toBe(true)
    expect(admitsNull({ $ref: "#/$defs/SymbolId" }, defs)).toBe(false)
  })
})
