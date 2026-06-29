import { readFile } from "node:fs/promises"
import type { PluginManifest } from "@aburi/types"
import Ajv2020, {
  type ErrorObject,
  type SchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js"
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser"
import pluginSchema from "../../../schema/aburi.plugin.v1.json" with { type: "json" }
import { RegistryError } from "./errors"

// strictTypes: false because aburi.plugin.v1.json uses if/then sub-schemas that constrain
// already-typed array fields via `maxItems` without re-stating `"type": "array"`. ajv's
// strictTypes rejects that pattern even though it's well-formed JSON Schema. All other
// strict checks (strictTuples, strictRequired, etc.) remain on.
const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  allErrors: true,
  allowUnionTypes: false,
})
const validate: ValidateFunction<PluginManifest> = ajv.compile<PluginManifest>(
  pluginSchema satisfies SchemaObject,
)

/** True for plain object literals (excludes arrays, null, class instances). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

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

/** Extract the plugin name from a partially-parsed manifest for error attribution. */
function tryGetName(parsed: unknown): string[] {
  if (isPlainObject(parsed) && typeof parsed.name === "string") {
    return [parsed.name]
  }
  return []
}

/** Pure JSONC → PluginManifest. Useful for in-memory manifests (tests). */
export function parsePluginManifest(text: string, sourcePath: string): PluginManifest {
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const summary = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join("; ")
    throw new RegistryError(`Plugin manifest at ${sourcePath} is not valid JSONC: ${summary}`, {
      code: "manifest-parse-failed",
      plugins: [],
    })
  }

  if (!validate(parsed)) {
    const errorDetail = formatAjvErrors(validate.errors)
    throw new RegistryError(
      `Plugin manifest at ${sourcePath} does not conform to aburi.plugin.v1.json: ${errorDetail}`,
      { code: "manifest-invalid", plugins: tryGetName(parsed) },
    )
  }

  return parsed
}

/** Read + parse + ajv-validate a manifest file on disk. */
export async function loadPluginManifest(path: string): Promise<PluginManifest> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err: unknown) {
    // Include the errno in the message so log shippers that strip `cause` still
    // surface why the read failed (ENOENT vs EACCES vs EISDIR, …).
    const errno = getErrno(err)
    throw new RegistryError(
      `Failed to read plugin manifest at ${path} (${errno})`,
      { code: "manifest-read-failed", plugins: [] },
      { cause: err },
    )
  }
  return parsePluginManifest(text, path)
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown validation failure"
  return errors.map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim()).join("; ")
}
