import { readFile } from "node:fs/promises"
import type { Config } from "@aburi/types"
import Ajv2020, {
  type ErrorObject,
  type SchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js"
import { type ParseError, type ParseOptions, parse, printParseErrorCode, visit } from "jsonc-parser"
import configSchema from "../../../schema/aburi.config.v1.json" with { type: "json" }
import { ConfigError, MISSING_FILE_ERRNOS } from "./errors"

const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  allErrors: true,
  allowUnionTypes: false,
})
const validate: ValidateFunction<Config> = ajv.compile<Config>(configSchema satisfies SchemaObject)

/**
 * One set of options for both reads of the text. `parse` is `visit` with an error-collecting
 * visitor, so the repeated-key walk sees what `parse` accepted only while the two agree.
 */
const CONFIG_PARSE_OPTIONS: ParseOptions = { allowTrailingComma: true, disallowComments: false }

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
 * Parse a JSONC config string, refuse a key its text names twice, validate against the schema,
 * then refuse duplicate component ids and hint names. The key check reads the text rather than
 * the parsed value, which has already kept one of the two, so it runs before the schema does.
 */
export function parseConfig(text: string, sourcePath: string): Config {
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, CONFIG_PARSE_OPTIONS)
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

  rejectRepeatedKeys(text, sourcePath)

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

/** Read a config file on disk and hand its text to `parseConfig`. */
export async function readConfigFile(path: string): Promise<Config> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err: unknown) {
    const errno = getErrno(err)
    // A path the caller named and a path the filesystem refused are different mistakes with
    // different remedies — fix the name, or fix the permission — so they are different codes.
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

/**
 * Refuse an object that names one key twice, at any depth. JSONC parsing keeps the last and says
 * nothing, so `{ "ignore": ["a/**"], "ignore": ["b/**"] }` would drop `a/**` with no sign the file
 * asked for it.
 *
 * `__proto__` is refused once: the parser assigns it, which replaces the object's prototype
 * rather than adding a key, so the schema never sees what it holds while a property read still
 * finds it.
 */
function rejectRepeatedKeys(text: string, sourcePath: string): void {
  const open: Set<string>[] = []
  // Widened by the cast: the callbacks assign it, which narrowing after `visit` cannot see.
  let found = null as { message: string; cause: RepeatedKey } | null
  visit(
    text,
    {
      // Returning `false` here would silence every callback below this object.
      onObjectBegin: () => {
        open.push(new Set())
      },
      onObjectEnd: () => {
        open.pop()
      },
      onObjectProperty: (key, _offset, _length, line, column, pathOf) => {
        const keys = open.at(-1)
        if (found !== null || keys === undefined) return
        const repeated = keys.has(key)
        if (repeated || key === PROTOTYPE_KEY) {
          const path = pathOf()
          const owner = path.length === 0 ? "the top-level object" : `/${path.join("/")}`
          const at = `line ${line + 1}, column ${column + 1}`
          found = {
            message: repeated
              ? `names "${key}" twice in ${owner} (again at ${at})`
              : `names "${key}" as a key in ${owner} (at ${at}); it replaces the object's ` +
                "prototype instead of adding a key, so the schema cannot see it",
            cause: { key, path, line: line + 1, column: column + 1 },
          }
        }
        keys.add(key)
      },
    },
    CONFIG_PARSE_OPTIONS,
  )
  if (found !== null) {
    throw new ConfigError(
      `Config at ${sourcePath} ${found.message}`,
      { code: "config-invalid" },
      { cause: found.cause },
    )
  }
}

const PROTOTYPE_KEY = "__proto__"

/** Where `rejectRepeatedKeys` stopped: the key, its owner's JSON path, and 1-based position. */
interface RepeatedKey {
  key: string
  path: readonly (string | number)[]
  line: number
  column: number
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
