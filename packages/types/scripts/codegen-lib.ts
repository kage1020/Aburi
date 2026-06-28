import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compile, type Options as JstOptions } from "json-schema-to-typescript"

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, "..")
const REPO_ROOT = resolve(PKG_ROOT, "../..")

export const SCHEMA_DIR = join(REPO_ROOT, "schema")
export const OUT_DIR = join(PKG_ROOT, "src", "generated")

export interface SchemaEntry {
  schema: string
  out: string
  rootName: string
  // Loose `interface X {}` placeholders to rewrite as re-exports from another generated
  // module. Used for cross-schema $ref-by-description patterns (e.g., diff schema's
  // Symbol/Component/Dependency are deliberately loose and point back to ir schema).
  crossRefs?: Record<string, string>
}

export const ENTRIES: readonly SchemaEntry[] = [
  { schema: "aburi.ir.v1.json", out: "ir.ts", rootName: "IR" },
  { schema: "aburi.config.v1.json", out: "config.ts", rootName: "Config" },
  {
    schema: "aburi.diff.v1.json",
    out: "diff.ts",
    rootName: "DiffResult",
    crossRefs: { Symbol: "./ir", Component: "./ir", Dependency: "./ir" },
  },
  { schema: "aburi.plugin.v1.json", out: "plugin.ts", rootName: "PluginManifest" },
] as const

const JST_OPTIONS: Partial<JstOptions> = {
  additionalProperties: false,
  bannerComment: "",
  declareExternallyReferenced: true,
  enableConstEnums: false,
  format: false,
  ignoreMinAndMaxItems: true,
  strictIndexSignatures: true,
  style: { semi: false, singleQuote: false, trailingComma: "all", printWidth: 100 },
  unknownAny: true,
  unreachableDefinitions: false,
}

const HEADER = [
  "// AUTO-GENERATED — DO NOT EDIT.",
  "// Source: schema/<file>.json",
  "// Run `pnpm --filter @aburi/types codegen` to regenerate.",
  "",
].join("\n")

function rewriteCrossRefs(source: string, crossRefs: Record<string, string>): string {
  let out = source

  // 1. Strip empty placeholders. Match optional `/** ... */` JSDoc + `export interface X {\n}`.
  //    JSDoc inner uses `(?:[^*]|\*(?!\/))*` so it cannot cross `*/` boundaries, otherwise the
  //    non-greedy variant `[\s\S]*?` would backtrack across earlier definitions (e.g. DiffResult's
  //    own JSDoc → Symbol's JSDoc) and delete everything between.
  for (const name of Object.keys(crossRefs)) {
    const pattern = new RegExp(
      String.raw`(?:\/\*\*(?:[^*]|\*(?!\/))*\*\/\s*)?export interface ${name}\s*\{\s*\}\s*\n`,
      "g",
    )
    out = out.replace(pattern, "")
  }

  // 2. Group imports/re-exports by source module so duplicate imports collapse.
  //    `export type {} from "./mod.ts"` re-exports names but does NOT bring them into local
  //    scope. Emit both `import type` (for local refs like SymbolAdded.symbol: Symbol) and
  //    `export type` (so consumers of the diff barrel see them).
  const bySource = new Map<string, string[]>()
  for (const [name, source] of Object.entries(crossRefs)) {
    const list = bySource.get(source) ?? []
    list.push(name)
    bySource.set(source, list)
  }

  const headers = [...bySource.entries()]
    .flatMap(([src, names]) => {
      const sorted = names.sort().join(", ")
      return [`import type { ${sorted} } from "${src}"`, `export type { ${sorted} } from "${src}"`]
    })
    .join("\n")

  return `${headers}\n${out.trimStart()}`
}

async function generateContent(entry: SchemaEntry): Promise<string> {
  const schemaPath = join(SCHEMA_DIR, entry.schema)
  const raw = await readFile(schemaPath, "utf8")
  const schema = JSON.parse(raw) as Record<string, unknown>
  schema.title = entry.rootName
  const ts = await compile(schema, entry.rootName, JST_OPTIONS)

  const normalized = ts
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
  let body = `${normalized}\n`
  if (entry.crossRefs) {
    body = rewriteCrossRefs(body, entry.crossRefs)
  }

  const banner = HEADER.replace("<file>", entry.schema.replace(/\.json$/, ""))
  return banner + body
}

/** Generate every schema's TypeScript in-memory. Used by both the CLI and the drift test. */
export async function generateAll(): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of ENTRIES) {
    result[entry.out] = await generateContent(entry)
  }
  return result
}
