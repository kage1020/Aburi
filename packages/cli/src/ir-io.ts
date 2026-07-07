import { readFile } from "node:fs/promises"
import { assertIRIntegrity } from "@aburi/core"
import type { IR } from "@aburi/types"
import { CliError } from "./errors"

const IR_SCHEMA_URL = "https://aburi.dev/schema/aburi.ir.v1.json"

/**
 * Read an IR file from disk and validate it enough to catch obvious corruption before
 * downstream code (buildDiff, explain lookup) hits an undefined-property crash. The
 * three failure modes are separated so the CLI can map them to distinct exit codes:
 * - Missing / permission / IO failure → `input-error` (exit 2)
 * - Malformed JSON                    → `input-error` (exit 2)
 * - Schema-shape mismatch             → `config-error` (exit 2)
 *
 * We reuse `@aburi/core` `assertIRIntegrity` when the tree looks well-formed enough to
 * run it; when the top-level shape is wrong we throw locally with a clearer message
 * because the integrity checker assumes the object it receives is already an IR.
 */
export async function readIR(path: string): Promise<IR> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    throw new CliError(`Failed to read IR file "${path}": ${errorMessage(error)}`, "input-error", {
      cause: error,
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new CliError(
      `IR file "${path}" is not valid JSON: ${errorMessage(error)}`,
      "input-error",
      { cause: error },
    )
  }
  if (!isPlainObject(parsed)) {
    throw new CliError(`IR file "${path}" is not an object at the root.`, "config-error")
  }
  if (parsed.$schema !== IR_SCHEMA_URL) {
    throw new CliError(
      `IR file "${path}" has unexpected $schema "${String(parsed.$schema)}"; expected "${IR_SCHEMA_URL}".`,
      "config-error",
    )
  }
  for (const field of ["symbols", "components", "dependencies"] as const) {
    if (!Array.isArray(parsed[field])) {
      throw new CliError(
        `IR file "${path}" is missing required array field "${field}".`,
        "config-error",
      )
    }
  }
  const ir = parsed as unknown as IR
  try {
    assertIRIntegrity(ir)
  } catch (error) {
    throw new CliError(
      `IR file "${path}" failed integrity check: ${errorMessage(error)}`,
      "config-error",
      { cause: error },
    )
  }
  return ir
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
