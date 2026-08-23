import { readFile } from "node:fs/promises"
import { assertIRIntegrity } from "@aburi/core"
import type { IR } from "@aburi/types"
import { CliError, errorMessage } from "./errors"

const IR_SCHEMA_URL = "https://aburi.dev/schema/aburi.ir.v1.json"

/**
 * Read an IR file from disk and establish that what comes back is one, so downstream code
 * — `buildDiff`, the `explain` lookup — can hold the branded type without checking again.
 *
 * Three failure modes, distinguished by `CliErrorCode` rather than by exit code (all three
 * are exit 2 per `../exit-codes`); the code is what the CLI reports and what tests assert:
 * - Missing / permission / IO failure → `input-error`
 * - Malformed JSON                    → `input-error`
 * - Not an `aburi.ir.v1` Document     → `config-error`
 *
 * Shape is left entirely to `assertIRIntegrity`, which reports a missing or mistyped field
 * as invariant #20 and names it. A second copy here would only be a second place for the
 * answer to drift from the one the invariant list gives. Two checks stay because neither is
 * about shape: `$schema` identifies the document format — a v2 document could satisfy every
 * v1 invariant and still not be one — and the root-object test is what makes reading
 * `$schema` off the parsed value legal in the first place.
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
