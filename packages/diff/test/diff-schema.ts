import diffSchema from "@aburi/schema/aburi.diff.v1.json" with { type: "json" }
import Ajv2020, { type SchemaObject, type ValidateFunction } from "ajv/dist/2020.js"

let validateDiff: ValidateFunction | null = null

/** Every way `document` breaks the diff schema, as `<instancePath> <keyword>`; empty when none. */
export function diffSchemaViolations(document: unknown): string[] {
  validateDiff ??= new Ajv2020({ strict: true, strictTypes: false, allErrors: true }).compile(
    diffSchema satisfies SchemaObject,
  )
  if (validateDiff(document)) return []
  return (validateDiff.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.keyword}`)
}
