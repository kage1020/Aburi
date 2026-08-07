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
 * Shape is not checked here beyond `$schema`. `assertIRIntegrity` reports a missing or
 * mistyped container as invariant #20 and names the field, so a second copy of that check
 * would only be a second place for the answer to drift from the one the invariant list
 * gives. `$schema` stays because it identifies the document format rather than describing
 * its contents — a v2 document could satisfy every v1 invariant and still not be one.
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
  try {
    assertIRIntegrity(parsed)
  } catch (error) {
    throw new CliError(
      `IR file "${path}" failed integrity check: ${errorMessage(error)}`,
      "config-error",
      { cause: error },
    )
  }
  // Branded after the check, not before: what makes this object an `IR` is having passed
  // the invariants, and asserting the type first is what let a malformed document reach
  // code that trusted it.
  return parsed as unknown as IR
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
