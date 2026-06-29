import { readFile } from "node:fs/promises"
import type { Config } from "@aburi/types"
import Ajv2020, {
  type ErrorObject,
  type SchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js"
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser"
import configSchema from "../../../schema/aburi.config.v1.json" with { type: "json" }
import { ConfigError } from "./errors"

const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  allErrors: true,
  allowUnionTypes: false,
})
const validate: ValidateFunction<Config> = ajv.compile<Config>(configSchema satisfies SchemaObject)

/**
 * Extract a string `code` property from any thrown value. Accepts both plain objects
 * (`{ code: "X" }`) and class instances (Node's SystemError, which Error.prototype-inherits
 * so a plain-object check would reject it). Falls back to "unknown" when no string code exists.
 */
function getErrno(value: unknown): string {
  if (value === null || typeof value !== "object") return "unknown"
  const code = (value as { code?: unknown }).code
  return typeof code === "string" ? code : "unknown"
}

/**
 * Parse + ajv-validate + duplicate-key-check a JSONC config string. The "Pure" qualifier
 * means no I/O — not "no semantic work": this returns only when every rule the schema
 * cannot express (duplicate component ids, duplicate hint names) also passes.
 */
export function parseConfig(text: string, sourcePath: string): Config {
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const summary = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset} (len ${e.length})`)
      .join("; ")
    // cause carries the structured ParseError[] (codes + offsets + lengths) so IDE / Sentry
    // integrations can render rich diagnostics without re-parsing the message string.
    throw new ConfigError(
      `Config at ${sourcePath} is not valid JSONC: ${summary}`,
      { code: "config-parse-failed" },
      { cause: errors },
    )
  }

  if (!validate(parsed)) {
    const ajvErrors = validate.errors ?? []
    const errorDetail = formatAjvErrors(ajvErrors)
    // cause carries the structured ajv ErrorObject[] (instancePath, schemaPath, params,
    // keyword) so the consumer can highlight the offending field in an editor without
    // string-parsing the message.
    throw new ConfigError(
      `Config at ${sourcePath} does not conform to aburi.config.v1.json: ${errorDetail}`,
      { code: "config-invalid" },
      { cause: ajvErrors },
    )
  }

  enforceDuplicateRules(parsed, sourcePath)
  return parsed
}

/** Read + parse + ajv-validate + duplicate-key-check a config file on disk. */
export async function readConfigFile(path: string): Promise<Config> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err: unknown) {
    const errno = getErrno(err)
    throw new ConfigError(
      `Failed to read config at ${path} (${errno})`,
      { code: "config-read-failed" },
      { cause: err },
    )
  }
  return parseConfig(text, path)
}

function enforceDuplicateRules(config: Config, sourcePath: string): void {
  const componentIds = new Set<string>()
  for (const c of config.components ?? []) {
    if (componentIds.has(c.id)) {
      throw new ConfigError(
        `Config at ${sourcePath} declares components[].id "${c.id}" more than once`,
        { code: "duplicate-component-id", value: c.id },
      )
    }
    componentIds.add(c.id)
  }

  const hintNames = new Set<string>()
  for (const h of config.frameworkHints ?? []) {
    if (hintNames.has(h.name)) {
      throw new ConfigError(
        `Config at ${sourcePath} declares frameworkHints[].name "${h.name}" more than once`,
        { code: "duplicate-hint-name", value: h.name },
      )
    }
    hintNames.add(h.name)
  }
}

/**
 * ajv with `allErrors: true` always populates `errors[]` on a false result. An empty array
 * here means ajv itself is in an unexpected state (likely a schema-compile bug), not a
 * recoverable user error — throw so we don't silently emit a meaningless message.
 */
function formatAjvErrors(errors: ErrorObject[]): string {
  if (errors.length === 0) {
    throw new Error("ajv invariant violation: validate returned false with empty errors[]")
  }
  return errors
    .map((e) => {
      const where = e.instancePath || "<root>"
      const params = formatAjvParams(e.params)
      return `${where} ${e.message ?? ""}${params}`.trim()
    })
    .join("; ")
}

/** Format ajv's `params` (additionalProperty, allowedValues, missingProperty, …) inline. */
function formatAjvParams(params: ErrorObject["params"]): string {
  if (params === null || typeof params !== "object") return ""
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  return entries.length > 0 ? ` [${entries.join(", ")}]` : ""
}
