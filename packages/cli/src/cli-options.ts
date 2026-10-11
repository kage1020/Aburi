import { InvalidArgumentError } from "commander"
import { CliError } from "./errors"

export type OutputFormat = "json" | "md" | "both"

export function definedOnly<T extends object>(
  fields: T,
): { [K in keyof T]-?: Exclude<T[K], undefined> } {
  const present: Partial<Record<keyof T, unknown>> = {}
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (fields[key] !== undefined) present[key] = fields[key]
  }
  return present as { [K in keyof T]-?: Exclude<T[K], undefined> }
}

export function parseFormat(value: string): OutputFormat {
  if (value === "json" || value === "md" || value === "both") return value
  throw new InvalidArgumentError(`--format must be one of: json | md | both`)
}

export function parseMaxBytes(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError(`--max-bytes must be a positive integer (got "${value}")`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`--max-bytes is too large to be a byte count (got "${value}")`)
  }
  return parsed
}

export function collect(value: string, accumulator: string[]): string[] {
  return [...accumulator, value]
}

export function deriveStrict(cmdOptions: {
  strict?: boolean
  discover?: boolean
}): boolean | undefined {
  if (cmdOptions.discover !== true) return cmdOptions.strict
  if (cmdOptions.strict === true) {
    throw new CliError("--strict and --discover contradict each other: drop one", "input-error")
  }
  return false
}

export function deriveFormat(cmdOptions: {
  format?: OutputFormat
  md?: boolean
  json?: boolean
}): OutputFormat {
  const dropped = [
    ...(cmdOptions.md === false ? ["--no-md"] : []),
    ...(cmdOptions.json === false ? ["--no-json"] : []),
  ]
  if (cmdOptions.format !== undefined) {
    const format = `--format ${cmdOptions.format}`
    const alreadyLeftOut =
      cmdOptions.format === "json" ? "--no-md" : cmdOptions.format === "md" ? "--no-json" : null
    const conflicting = dropped.filter((flag) => flag !== alreadyLeftOut)
    if (conflicting.length === 1) {
      throw new CliError(
        `${format} and ${conflicting[0]} contradict each other: drop one`,
        "input-error",
      )
    }
    if (conflicting.length === 2) {
      throw new CliError(
        `${format} contradicts both --no-md and --no-json: drop ${format}, or both of them`,
        "input-error",
      )
    }
    return cmdOptions.format
  }
  if (dropped.length === 2) {
    throw new CliError("--no-md and --no-json leave scan nothing to write", "input-error")
  }
  return cmdOptions.md === false ? "json" : cmdOptions.json === false ? "md" : "both"
}
