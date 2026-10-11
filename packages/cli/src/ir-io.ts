import { readFile } from "node:fs/promises"
import { assertIRIntegrity } from "@aburi/core"
import type { IR } from "@aburi/types"
import { CliError, errorMessage } from "./errors"

const IR_SCHEMA_URL = "https://aburi.kage1020.com/schema/aburi.ir.v1.json"

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
  return parsed as unknown as IR
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
