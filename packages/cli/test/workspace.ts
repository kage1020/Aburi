import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { IR } from "@aburi/types"

export const CONFIG_SCHEMA_URL = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

export const TYPESCRIPT = { languages: ["lang-typescript"] }

export async function writeFileAt(root: string, rel: string, content: string): Promise<void> {
  const path = resolve(root, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
}

export async function writeConfig(
  directory: string,
  config: Record<string, unknown>,
  filename = "aburi.json",
): Promise<void> {
  await writeFileAt(directory, filename, JSON.stringify({ $schema: CONFIG_SCHEMA_URL, ...config }))
}

export async function writePackageJson(
  directory: string,
  manifest: Record<string, unknown> = { name: "fixture", private: true },
): Promise<void> {
  await writeFileAt(directory, "package.json", JSON.stringify(manifest))
}

/** A one-package TypeScript workspace whose only source declares nothing. */
export async function writeTypeScriptWorkspace(directory: string, name: string): Promise<void> {
  await writePackageJson(directory, { name, private: true })
  await writeConfig(directory, TYPESCRIPT)
  await writeFileAt(directory, "src/quiet.ts", "// declares nothing\n")
}

/** A pnpm workspace at `root` whose one package is `pkgs/app`, holding `alpha()`. */
export async function writeMonorepo(root: string): Promise<string> {
  await writeFileAt(root, "pnpm-workspace.yaml", "packages:\n  - 'pkgs/*'\n")
  await writePackageJson(root, { name: "root", private: true })
  const app = resolve(root, "pkgs/app")
  await writePackageJson(app, { name: "app" })
  await writeFileAt(app, "src/a.ts", "export function alpha() { return 1 }\n")
  return app
}

export async function writeIRs(
  directory: string,
  base: IR,
  head: IR,
): Promise<{ base: string; head: string }> {
  const paths = { base: resolve(directory, "base.json"), head: resolve(directory, "head.json") }
  await writeFile(paths.base, JSON.stringify(base), "utf8")
  await writeFile(paths.head, JSON.stringify(head), "utf8")
  return paths
}
