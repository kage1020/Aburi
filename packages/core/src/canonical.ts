import { CoreError } from "./errors"

export interface SerializeOptions {
  /**
   * "pretty" emits 2-space indent + LF (the IR default; matches `aburi scan` output).
   * "compact" emits no whitespace (the `--compact` CLI mode and fingerprint input).
   */
  format?: "pretty" | "compact"
}

/**
 * Serialize any plain-JSON value into a byte-deterministic UTF-8 string.
 *
 * Three rules together guarantee bit-identical output for equal inputs:
 * 1. Every string is normalized to Unicode NFC before encoding. Composing characters from
 *    NFD ("é" written as "é") would otherwise change byte length even though the
 *    rendered text is identical.
 * 2. Object keys are sorted by UTF-16 code unit (not locale-aware). Within the Basic
 *    Multilingual Plane the ordering coincides with Unicode codepoint order; astral-plane
 *    strings differ, but this serializer, the integrity checker's sort-order invariant,
 *    and every consumer that uses the default `<`/`>` operators or `Array.prototype.sort`
 *    all agree on UTF-16 code unit order, so the three paths cannot diverge.
 * 3. Array order is preserved; the caller is responsible for sorting arrays per the IR
 *    schema's per-collection ordering rules (this serializer is not in the business of
 *    interpreting which collection is which).
 *
 * Non-JSON values (functions, symbols, bigint, undefined, Map/Set, Date, class instances)
 * throw CoreError "non-plain-json" so silent coercion to "{}" or "null" cannot leak into
 * the IR and corrupt fingerprints downstream.
 */
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
      return JSON.stringify(value.normalize("NFC"))
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
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    )
    if (entries.length === 0) return "{}"
    entries.sort(([a], [b]) => compareByCodeUnit(a, b))
    const childIndent = indent.repeat(depth + 1)
    const closeIndent = indent.repeat(depth)
    const rendered = entries.map(([k, v]) => {
      const keyJson = JSON.stringify(k.normalize("NFC"))
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

/** Lexicographic compare by UTF-16 code unit (matches Array.prototype.sort default for strings). */
function compareByCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
