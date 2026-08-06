import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020, { type ErrorObject } from "ajv/dist/2020"

/**
 * Compiled validator for `schema/aburi.ir.v1.json`, returning the violations rather than a
 * boolean so a failing assertion prints what broke instead of `expected false to be true`.
 *
 * The v1 schemas are frozen and are the stated source of truth for the IR, so a produced
 * document failing them is a contract break: a downstream consumer that validates rejects
 * every document. The integrity invariants encode cross-field relationships the schema
 * cannot express and never check the schema itself, so the two are complementary.
 */
export async function irValidator(): Promise<(doc: unknown) => string[]> {
  const here = fileURLToPath(import.meta.url)
  const repoRoot = resolve(dirname(here), "..", "..", "..")
  const raw = await readFile(resolve(repoRoot, "schema", "aburi.ir.v1.json"), "utf8")

  // `strict: true` refuses to compile the frozen schema (strictTypes / strictRequired), and
  // `false` silences the diagnostics entirely; `"log"` keeps validation power and prints
  // anything ajv would have objected to.
  const ajv = new Ajv2020({ allErrors: true, strict: "log" })
  // ajv ships no `date-time` implementation, and registering `true` makes every string pass
  // — including `"not-a-timestamp"`. The IR writes RFC 3339 / ISO 8601, so check that.
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)

  const validate = ajv.compile(JSON.parse(raw))
  return (doc: unknown) => (validate(doc) ? [] : describeErrors(validate.errors ?? []))
}

function describeErrors(errors: readonly ErrorObject[]): string[] {
  return errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`)
}
