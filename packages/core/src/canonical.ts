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
 * 1. Every string is normalized to Unicode NFC (ir-schema.md §1.2, which states why the
 *    form matters and where the rest of the pipeline establishes it). Keys are normalized
 *    *before* rule 2 orders them: ordering the input spelling and writing the normalized
 *    one yields a document whose key order does not match the bytes it contains.
 * 2. Object keys are sorted by UTF-16 code unit, per ir-schema.md §1. Rule 1 is what lets
 *    that comparator agree with the rest of the codebase: this function orders normalized
 *    keys while every other ordering decision compares the string held in memory, so the
 *    two stay in step only because §1.2 puts both in the same form.
 * 3. Array order is preserved; the caller is responsible for sorting arrays per the IR
 *    schema's per-collection ordering rules (this serializer is not in the business of
 *    interpreting which collection is which).
 *
 * Two failure modes, both loud rather than lossy. Non-JSON values (functions, symbols,
 * bigint, Map/Set, Date, class instances) throw `non-plain-json`, so silent coercion to
 * "{}" or "null" cannot leak into the IR and corrupt fingerprints downstream. Keys that
 * collide under NFC throw `canonical-key-collision`, since a parser reading the result
 * would keep only one of them.
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
    const entries = normalizedEntries(value as Record<string, unknown>, path)
    if (entries.length === 0) return "{}"
    entries.sort(([a], [b]) => compareByCodeUnit(a, b))
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

/** Lexicographic compare by UTF-16 code unit (matches Array.prototype.sort default for strings). */
function compareByCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Own enumerable entries with `undefined` values dropped and every key normalized to NFC.
 *
 * Two keys can be distinct in JavaScript and identical once normalized — `"é"` written as
 * one code point versus `e` plus a combining acute. Emitting both yields
 * `{"é":1,"é":2}`: JSON a parser accepts and silently collapses, losing an entry. That is
 * the same class of lossy coercion the non-JSON-value rejection exists to prevent, so it
 * fails the same way rather than quietly.
 */
function normalizedEntries(value: Record<string, unknown>, path: string): [string, unknown][] {
  const out: [string, unknown][] = []
  const seen = new Map<string, string>()
  for (const [rawKey, entry] of Object.entries(value)) {
    // Skipped before the collision check on purpose: `{ [NFD]: 1, [NFC]: undefined }` writes
    // one key and loses nothing, so it is not a collision. A key with no value is not a key.
    if (entry === undefined) continue
    const key = rawKey.normalize("NFC")
    const prior = seen.get(key)
    if (prior !== undefined) {
      throw new CoreError(
        `serializeCanonical at ${path}: keys ${describeKey(prior)} and ${describeKey(rawKey)} render identically and are identical after Unicode NFC normalization, so writing both would lose one. Rename one to the composed form.`,
        { code: "canonical-key-collision", value: path },
      )
    }
    seen.set(key, rawKey)
    out.push([key, entry])
  }
  return out
}

/**
 * Render a key alongside its code points. Colliding keys look the same on screen by
 * definition, so quoting them twice would produce a message that names no difference.
 */
function describeKey(key: string): string {
  const codePoints = [...key]
    .map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ")
  return `${JSON.stringify(key)} (${codePoints})`
}
