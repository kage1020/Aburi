import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020, { type ErrorObject } from "ajv/dist/2020"

export async function irValidator(): Promise<(doc: unknown) => string[]> {
  const here = fileURLToPath(import.meta.url)
  const repoRoot = resolve(dirname(here), "..", "..", "..")
  const raw = await readFile(resolve(repoRoot, "schema", "aburi.ir.v1.json"), "utf8")

  const ajv = new Ajv2020({ allErrors: true, strict: "log" })
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)

  const validate = ajv.compile(JSON.parse(raw))
  return (doc: unknown) => (validate(doc) ? [] : describeErrors(validate.errors ?? []))
}

function describeErrors(errors: readonly ErrorObject[]): string[] {
  return errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`)
}
