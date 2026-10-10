import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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
  return resolve(dirname(here), "..", "package.json")
}
