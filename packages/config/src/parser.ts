import { readFile } from "node:fs/promises"
import {
  describeRepeatedKey,
  JSONC_PARSE_OPTIONS,
  scanKeys,
} from "@aburi/plugin-registry/repeated-keys"
import type { Config } from "@aburi/types"
import Ajv2020, {
  type ErrorObject,
  type SchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js"
import { type ParseError, type ParseOptions, parse, printParseErrorCode } from "jsonc-parser"
import configSchema from "../../../schema/aburi.config.v1.json" with { type: "json" }
import { ConfigError, MISSING_FILE_ERRNOS } from "./errors"

const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  allErrors: true,
  allowUnionTypes: false,
})
const validate: ValidateFunction<Config> = ajv.compile<Config>(configSchema satisfies SchemaObject)

/** The options `scanKeys` reads with, so the key check sees what `parse` accepted. */
const CONFIG_PARSE_OPTIONS: ParseOptions = JSONC_PARSE_OPTIONS

function getErrno(value: unknown): string {
  if (value === null || typeof value !== "object") return "unknown"
  const code = (value as { code?: unknown }).code
  return typeof code === "string" ? code : "unknown"
}

export function parseConfig(text: string, sourcePath: string): Config {
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, CONFIG_PARSE_OPTIONS)
  if (errors.length > 0) {
    const summary = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset} (len ${e.length})`)
      .join("; ")
    throw new ConfigError(
      `Config at ${sourcePath} is not valid JSONC: ${summary}`,
      { code: "config-parse-failed" },
      { cause: errors },
    )
  }

  rejectRepeatedKeys(text, sourcePath)

  if (!validate(parsed)) {
    const ajvErrors = validate.errors ?? []
    const errorDetail = formatAjvErrors(ajvErrors)
    throw new ConfigError(
      `Config at ${sourcePath} does not conform to aburi.config.v1.json: ${errorDetail}`,
      { code: "config-invalid" },
      { cause: ajvErrors },
    )
  }

  enforceDuplicateRules(parsed, sourcePath)
  return parsed
}

/** Read a config file on disk and hand its text to `parseConfig`. */
export async function readConfigFile(path: string): Promise<Config> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err: unknown) {
    const errno = getErrno(err)
    if (MISSING_FILE_ERRNOS.has(errno)) {
      throw new ConfigError(
        `No config file at ${path}`,
        { code: "config-not-found" },
        { cause: err },
      )
    }
    throw new ConfigError(
      `Failed to read config at ${path} (${errno})`,
      { code: "config-read-failed" },
      { cause: err },
    )
  }
  return parseConfig(text, path)
}

/** Refuse a key the text names twice in one object, or `__proto__` at all (`scanKeys`). */
function rejectRepeatedKeys(text: string, sourcePath: string): void {
  const scan = scanKeys(text)
  if (scan.kind === "unreadable") {
    throw new Error("jsonc invariant violation: parse accepted a text scanKeys could not read")
  }
  if (scan.kind !== "clean") {
    throw new ConfigError(
      describeRepeatedKey(scan, `Config at ${sourcePath}`),
      { code: "config-invalid" },
      { cause: scan },
    )
  }
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
