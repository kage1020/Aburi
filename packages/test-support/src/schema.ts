import irSchema from "@aburi/schema/aburi.ir.v1.json" with { type: "json" }
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js"

let validateIR: ValidateFunction | null = null

/** Every way `document` breaks the IR schema, as `<instancePath> <message>`; empty when none. */
export function irSchemaViolations(document: unknown): string[] {
  validateIR ??= compileIRSchema()
  if (validateIR(document)) return []
  return (validateIR.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`)
}

function compileIRSchema(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: "log" })
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  return ajv.compile(irSchema)
}
