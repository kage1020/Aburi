import { describeCodePoints, toNfc } from "./codepoints"
import { CoreError } from "./errors"
import { compareCodeUnit } from "./order"

export interface SerializeOptions {
  format?: "pretty" | "compact"
}

interface Layout {
  indent: string
  newline: string
  colon: string
}

const PRETTY: Layout = { indent: "  ", newline: "\n", colon: ": " }
const COMPACT: Layout = { indent: "", newline: "", colon: ":" }

export function serializeCanonical(value: unknown, options: SerializeOptions = {}): string {
  return write(value, "$", 0, options.format === "compact" ? COMPACT : PRETTY)
}

function write(value: unknown, path: string, depth: number, layout: Layout): string {
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
    const items = value.map((v, i) => write(v, `${path}[${i}]`, depth + 1, layout))
    return enclose("[", items, "]", depth, layout)
  }
  if (typeof value === "object") {
    assertPlainObject(value, path)
    const entries = normalizedEntries(value as Record<string, unknown>, path)
    if (entries.length === 0) return "{}"
    entries.sort(([a], [b]) => compareCodeUnit(a, b))
    const members = entries.map(
      ([k, v]) =>
        `${JSON.stringify(k)}${layout.colon}${write(v, `${path}.${k}`, depth + 1, layout)}`,
    )
    return enclose("{", members, "}", depth, layout)
  }
  throw rejectNonJson(typeof value, path)
}

function enclose(
  open: string,
  items: readonly string[],
  close: string,
  depth: number,
  { indent, newline }: Layout,
): string {
  const childIndent = indent.repeat(depth + 1)
  const body = items.map((item) => `${childIndent}${item}`).join(`,${newline}`)
  return `${open}${newline}${body}${newline}${indent.repeat(depth)}${close}`
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
