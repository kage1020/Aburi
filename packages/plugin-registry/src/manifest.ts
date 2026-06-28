import { readFile } from "node:fs/promises"
import type { PluginManifest } from "@aburi/types"
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js"
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
  pluginSchema as unknown as object,
)

/** Pure JSONC → PluginManifest. Useful for in-memory manifests (tests). */
export function parsePluginManifest(text: string, sourcePath: string): PluginManifest {
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const summary = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join("; ")
    throw new RegistryError(`Plugin manifest at ${sourcePath} is not valid JSONC: ${summary}`, {
      code: "manifest-invalid",
      plugins: [],
    })
  }

  if (!validate(parsed)) {
    const errorDetail = formatAjvErrors(validate.errors)
    throw new RegistryError(
      `Plugin manifest at ${sourcePath} does not conform to aburi.plugin.v1.json: ${errorDetail}`,
      {
        code: "manifest-invalid",
        plugins:
          typeof (parsed as { name?: unknown })?.name === "string"
            ? [(parsed as { name: string }).name]
            : [],
      },
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
    throw new RegistryError(
      `Failed to read plugin manifest at ${path}`,
      {
        code: "manifest-invalid",
        plugins: [],
      },
      { cause: err },
    )
  }
  return parsePluginManifest(text, path)
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown validation failure"
  return errors.map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim()).join("; ")
}
