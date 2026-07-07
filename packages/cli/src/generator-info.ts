import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Every command that produces an IR / diff needs to stamp `generator.name / version` on
 * the output. Centralising the read here means bumping `@aburi/cli` in `package.json`
 * automatically propagates through init/scan/diff without shadow-copies of the version
 * string — the review flagged three separate `"0.0.0"` literals that were destined to
 * drift as soon as the first version bump landed.
 *
 * Reads `../../package.json` relative to the compiled bundle, memoises the parse. The
 * package.json lives inside the shipped tarball (§`files` field), so the read succeeds
 * both in the dist bundle and when running from source under Vitest.
 */
let cached: { name: string; version: string } | null = null

export async function readGeneratorInfo(): Promise<{ name: string; version: string }> {
  if (cached !== null) return cached
  const packageJsonPath = locatePackageJson()
  const raw = await readFile(packageJsonPath, "utf8")
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown }
  if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error(`@aburi/cli package.json at ${packageJsonPath} is missing name/version fields.`)
  }
  cached = { name: "aburi", version: parsed.version }
  return cached
}

function locatePackageJson(): string {
  const here = fileURLToPath(import.meta.url)
  // Walk up until we find a directory containing package.json — handles both
  // `src/generator-info.ts` (during Vitest) and `dist/index.mjs` (built bundle).
  let dir = dirname(here)
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "package.json")
    if (candidate.endsWith("cli/package.json") || candidate.endsWith("cli\\package.json")) {
      return candidate
    }
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  // Fallback: two-levels-up guess.
  return resolve(dirname(here), "..", "package.json")
}
