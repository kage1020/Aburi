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

/** Pure JSONC → Config. Useful for in-memory configs (tests, CLI overrides). */
export function parseConfig(text: string, sourcePath: string): Config {
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const summary = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join("; ")
    throw new ConfigError(`Config at ${sourcePath} is not valid JSONC: ${summary}`, {
      code: "config-parse-failed",
    })
  }

  if (!validate(parsed)) {
    const errorDetail = formatAjvErrors(validate.errors)
    throw new ConfigError(
      `Config at ${sourcePath} does not conform to aburi.config.v1.json: ${errorDetail}`,
      { code: "config-invalid" },
    )
  }

  enforceDuplicateRules(parsed, sourcePath)
  return parsed
}

/** Read + parse + ajv-validate a config file on disk. Does not apply normalization. */
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

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown validation failure"
  return errors.map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim()).join("; ")
}
