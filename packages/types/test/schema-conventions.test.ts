import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SCHEMA_DIR } from "../scripts/codegen-lib"

/**
 * `docs/design/ir-schema.md` §1.1 splits every optional IR property into Class A
 * (nullable — the key is always written, carrying `null` when there is no value) and
 * Class B (non-nullable — the key's presence is itself the signal). The split follows
 * mechanically from the declared type, but which one a property means only reaches a
 * writer through its `description`.
 *
 * The failure this guards against is the one that produced the mixed conventions in the
 * first place: an optional property lands with no stated rule, two writers pick opposite
 * readings, and the ambiguity is only noticed once a reader has to defend against three
 * states. A missing or contradictory `description` is the observable form of "the class
 * was never declared".
 */

interface SchemaProperty {
  description?: string
  type?: string | string[]
  oneOf?: Array<{ type?: string }>
}

interface SchemaObject {
  required?: string[]
  properties?: Record<string, SchemaProperty>
  $defs?: Record<string, SchemaObject>
}

interface OptionalProperty {
  owner: string
  name: string
  property: SchemaProperty
}

async function readIrSchema(): Promise<SchemaObject> {
  const raw = await readFile(join(SCHEMA_DIR, "aburi.ir.v1.json"), "utf8")
  return JSON.parse(raw) as SchemaObject
}

/** Every (owner, property) pair the IR schema declares as optional, in declaration order. */
function optionalProperties(schema: SchemaObject): OptionalProperty[] {
  const out: OptionalProperty[] = []
  const collect = (owner: string, node: SchemaObject): void => {
    const required = new Set(node.required ?? [])
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      if (!required.has(name)) out.push({ owner, name, property })
    }
  }
  collect("(root)", schema)
  for (const [defName, def] of Object.entries(schema.$defs ?? {})) {
    if (def.properties !== undefined) collect(defName, def)
  }
  return out
}

/** True when the property admits `null`, either inline or through a `oneOf` branch. */
function admitsNull(property: SchemaProperty): boolean {
  if (Array.isArray(property.type)) return property.type.includes("null")
  return (property.oneOf ?? []).some((branch) => branch.type === "null")
}

describe("aburi.ir.v1 optional-property conventions (ir-schema.md §1.1)", () => {
  it("every optional property declares its absent-vs-null convention in `description`", async () => {
    const undeclared = optionalProperties(await readIrSchema())
      .filter(({ property }) => (property.description ?? "").trim() === "")
      .map(({ owner, name }) => `${owner}.${name}`)

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
    // schema says -- the description is the only copy of the rule a plugin author sees,
    // via the JSDoc that codegen lifts into `src/generated/`.
    const mismatches = optionalProperties(await readIrSchema()).flatMap(
      ({ owner, name, property }) => {
        const description = property.description ?? ""
        const nullable = admitsNull(property)
        const claimsA = description.includes("Class A")
        const claimsB = description.includes("Class B")
        if (claimsA && claimsB) return [`${owner}.${name}: claims both classes`]
        if (nullable && !claimsA) return [`${owner}.${name}: nullable, so it must be Class A`]
        if (!nullable && !claimsB) return [`${owner}.${name}: non-nullable, so it must be Class B`]
        return []
      },
    )

    expect(mismatches).toEqual([])
  })
})
