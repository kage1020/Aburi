import { createHash } from "node:crypto"

const SEPARATOR_REGEX = /[:/#.]+/g
const CONSECUTIVE_DASHES = /-{2,}/g

/**
 * §8 — Symbol id → filesystem-safe basename (without `.md`).
 * Rules:
 *   1. `:` / `/` / `#` / `.` → `-`
 *   2. Consecutive dashes are collapsed to a single dash
 *   3. Trailing dashes are trimmed (would look like "file--.md" otherwise)
 *
 * §8 tail — deterministic collision suffix: `SHA-256(UTF-8(id))` first 3 bytes → 6 hex
 * chars. `sanitize` alone is NOT injective (`a.b` and `a-b` both map to `a-b`), so
 * callers that persist files must pair the sanitised base with a collision-aware writer.
 * `sanitizeSymbolId` returns the base; `withCollisionSuffix` appends the deterministic
 * suffix so the caller can compose "always append" or "append only on collision"
 * strategies without re-deriving the hash.
 */
export function sanitizeSymbolId(symbolId: string): string {
  const replaced = symbolId.replace(SEPARATOR_REGEX, "-")
  const collapsed = replaced.replace(CONSECUTIVE_DASHES, "-")
  return trimDashes(collapsed)
}

function trimDashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === "-") start++
  while (end > start && value[end - 1] === "-") end--
  return value.slice(start, end)
}

export function collisionSuffix(symbolId: string): string {
  const hash = createHash("sha256").update(symbolId, "utf8").digest()
  return hash.subarray(0, 3).toString("hex")
}

export function withCollisionSuffix(symbolId: string): string {
  return `${sanitizeSymbolId(symbolId)}-${collisionSuffix(symbolId)}`
}

/**
 * Assign filenames to a set of Symbol ids, guaranteeing uniqueness across the input.
 * When two DIFFERENT ids sanitise to the same base, both entries in the returned map
 * switch to the `-<hash>` variant. Callers that need "always-append" semantics can use
 * `withCollisionSuffix` directly.
 *
 * A duplicate id in the input (same string more than once) throws — the IR contract
 * (ir-schema §3) already forbids duplicate `Symbol.id`, so seeing one here means the
 * caller is either bypassing the integrity check or feeding the projection stale data.
 * Silent Map-overwrite of a duplicate would drop one entry from the returned filename
 * mapping.
 */
export function assignSymbolFilenames(symbolIds: readonly string[]): Map<string, string> {
  const bases: string[] = new Array(symbolIds.length)
  const baseCounts = new Map<string, number>()
  const seenIds = new Set<string>()
  for (let i = 0; i < symbolIds.length; i++) {
    const id = symbolIds[i]
    if (id === undefined) {
      throw new Error(
        `assignSymbolFilenames: symbolIds[${i}] is undefined — the caller passed a hole in the array.`,
      )
    }
    if (seenIds.has(id)) {
      throw new Error(
        `assignSymbolFilenames: duplicate Symbol id "${id}"; IR contract forbids duplicate ids at extraction time.`,
      )
    }
    seenIds.add(id)
    const base = sanitizeSymbolId(id)
    bases[i] = base
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  for (let i = 0; i < symbolIds.length; i++) {
    const id = symbolIds[i]
    const base = bases[i]
    if (id === undefined || base === undefined) {
      throw new Error(
        `assignSymbolFilenames: inconsistent internal state at index ${i}; this indicates a bug in this helper, not the caller.`,
      )
    }
    const count = baseCounts.get(base) ?? 0
    out.set(id, count > 1 ? `${base}-${collisionSuffix(id)}` : base)
  }
  return out
}
