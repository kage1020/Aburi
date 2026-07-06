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
 * When two ids sanitise to the same base, both entries in the returned map switch to the
 * `-<hash>` variant. Callers that need "always-append" semantics can use
 * `withCollisionSuffix` directly.
 */
export function assignSymbolFilenames(symbolIds: readonly string[]): Map<string, string> {
  const baseCounts = new Map<string, number>()
  const bases = symbolIds.map(sanitizeSymbolId)
  for (const b of bases) baseCounts.set(b, (baseCounts.get(b) ?? 0) + 1)
  const out = new Map<string, string>()
  for (let i = 0; i < symbolIds.length; i++) {
    const id = symbolIds[i]
    const base = bases[i]
    if (id === undefined || base === undefined) continue
    const count = baseCounts.get(base) ?? 0
    if (count > 1) out.set(id, `${base}-${collisionSuffix(id)}`)
    else out.set(id, base)
  }
  return out
}
