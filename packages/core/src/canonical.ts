import { describeCodePoints, toNfc } from "./codepoints"
import { CoreError } from "./errors"
import { compareCodeUnit } from "./order"

export interface SerializeOptions {
  format?: "pretty" | "compact"
}

export function serializeCanonical(value: unknown, options: SerializeOptions = {}): string {
  const format = options.format ?? "pretty"
  const indent = format === "pretty" ? "  " : ""
  const newline = format === "pretty" ? "\n" : ""
  const colon = format === "pretty" ? ": " : ":"
  return write(value, "$", 0, indent, newline, colon)
}

function write(
  value: unknown,
  path: string,
  depth: number,
  indent: string,
  newline: string,
  colon: string,
): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "number":
      return writeNumber(value, path)
    case "string":
      return JSON.stringify(toNfc(value))
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw rejectNonJson(typeof value, path)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const childIndent = indent.repeat(depth + 1)
    const closeIndent = indent.repeat(depth)
    const items = value.map((v, i) => write(v, `${path}[${i}]`, depth + 1, indent, newline, colon))
    return `[${newline}${items.map((s) => `${childIndent}${s}`).join(`,${newline}`)}${newline}${closeIndent}]`
  }
  if (typeof value === "object") {
    assertPlainObject(value, path)
    const entries = normalizedEntries(value as Record<string, unknown>, path)
    if (entries.length === 0) return "{}"
    entries.sort(([a], [b]) => compareCodeUnit(a, b))
    const childIndent = indent.repeat(depth + 1)
    const closeIndent = indent.repeat(depth)
    const rendered = entries.map(([k, v]) => {
      const keyJson = JSON.stringify(k)
      const valueJson = write(v, `${path}.${k}`, depth + 1, indent, newline, colon)
      return `${childIndent}${keyJson}${colon}${valueJson}`
    })
    return `{${newline}${rendered.join(`,${newline}`)}${newline}${closeIndent}}`
  }
  throw rejectNonJson(typeof value, path)
}

function writeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CoreError(
      `serializeCanonical at ${path}: non-finite number (${String(value)}) is not representable in JSON`,
      { code: "non-plain-json", value: path },
    )
  }
  return JSON.stringify(value)
}

function assertPlainObject(value: object, path: string): void {
  const proto = Object.getPrototypeOf(value)
  if (proto === Object.prototype || proto === null) return
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? "<anonymous>"
  throw new CoreError(
    `serializeCanonical at ${path}: non-plain object (${ctor}) is not representable in JSON; convert to a plain object first`,
    { code: "non-plain-json", value: path },
  )
}

function rejectNonJson(type: string, path: string): CoreError {
  return new CoreError(
    `serializeCanonical at ${path}: value of type "${type}" is not representable in JSON`,
    { code: "non-plain-json", value: path },
  )
}

function normalizedEntries(value: Record<string, unknown>, path: string): [string, unknown][] {
  const out: [string, unknown][] = []
  const seen = new Map<string, string>()
  for (const [rawKey, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    const key = toNfc(rawKey)
    const prior = seen.get(key)
    if (prior !== undefined) {
      throw new CoreError(
        `serializeCanonical at ${path}: keys ${describeCodePoints(prior)} and ${describeCodePoints(rawKey)} render identically and are identical after Unicode NFC normalization, so writing both would lose one. Rename one to the composed form.`,
        { code: "canonical-key-collision", value: path },
      )
    }
    seen.set(key, rawKey)
    out.push([key, entry])
  }
  return out
}
