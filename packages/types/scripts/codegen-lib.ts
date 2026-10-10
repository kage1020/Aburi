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
  crossRefs?: Record<string, string>
  aliasOverrides?: Record<string, string>
  unbrandedIds?: readonly string[]
}

/** Nominal-type right-hand side for an id alias that owns its own namespace. */
function brand(name: string): string {
  return `string & { readonly __brand: "${name}" }`
}

export const ENTRIES: readonly SchemaEntry[] = [
  {
    schema: "aburi.ir.v1.json",
    out: "ir.ts",
    rootName: "IR",
    aliasOverrides: {
      SymbolId: brand("SymbolId"),
      ComponentId: brand("ComponentId"),
      DependencyEndpoint: "SymbolId | ComponentId",
      LanguageId: brand("LanguageId"),
    },
    unbrandedIds: ["EffectId"],
  },
  { schema: "aburi.config.v1.json", out: "config.ts", rootName: "Config" },
  {
    schema: "aburi.diff.v1.json",
    out: "diff.ts",
    rootName: "DiffResult",
    crossRefs: { Symbol: "./ir", SymbolId: "./ir", Component: "./ir", Dependency: "./ir" },
    aliasOverrides: { SliceId: brand("SliceId") },
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

export class CodegenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CodegenError"
  }
}

function rewriteCrossRefs(
  schemaFile: string,
  body: string,
  crossRefs: Record<string, string>,
): string {
  let out = body

  for (const name of Object.keys(crossRefs)) {
    const pattern = new RegExp(
      String.raw`(?:\/\*\*(?:[^*]|\*(?!\/))*\*\/\s*)?export (?:interface ${name}\s*\{\s*\}|type ${name} = string)\s*\n`,
      "g",
    )
    const hits = [...out.matchAll(pattern)]
    if (hits.length !== 1) {
      throw new CodegenError(
        `crossRef rewrite expected exactly 1 loose placeholder (\`interface ${name} {}\` or ` +
          `\`type ${name} = string\`) in ${schemaFile}, found ${hits.length}. ` +
          `json-schema-to-typescript output format may have changed; inspect raw output and ` +
          `update rewriteCrossRefs().`,
      )
    }
    out = out.replace(pattern, "")
  }

  const bySource = new Map<string, string[]>()
  for (const [name, modulePath] of Object.entries(crossRefs)) {
    const list = bySource.get(modulePath) ?? []
    list.push(name)
    bySource.set(modulePath, list)
  }

  const headers = [...bySource.entries()]
    .flatMap(([src, names]) => {
      const sorted = names.sort().join(", ")
      return [`import type { ${sorted} } from "${src}"`, `export type { ${sorted} } from "${src}"`]
    })
    .join("\n")

  return `${headers}\n${out.trimStart()}`
}

const WRAPPER_PATTERN =
  /^export type (\w+) = \(\{\n\[k: string\]: unknown \| undefined\n\} & \{\n([\s\S]*?)\n\}\)$/gm

function stripPermissiveIntersection(schemaFile: string, source: string): string {
  let out = source
  for (const match of [...source.matchAll(WRAPPER_PATTERN)]) {
    const [whole, name, inner] = match
    if (name === undefined || inner === undefined) continue
    out = out.replace(whole, `export interface ${name} {\n${inner}\n}`)
  }
  if (WRAPPER_PATTERN.test(out)) {
    WRAPPER_PATTERN.lastIndex = 0
    throw new CodegenError(
      `stripPermissiveIntersection left a permissive wrapper in ${schemaFile}. ` +
        `json-schema-to-typescript wrapping format may have changed; inspect raw output ` +
        `and update the pattern.`,
    )
  }
  WRAPPER_PATTERN.lastIndex = 0
  return out
}

function applyAliasOverrides(
  schemaFile: string,
  body: string,
  aliasOverrides: Record<string, string>,
): string {
  let out = body
  for (const [name, replacement] of Object.entries(aliasOverrides)) {
    const pattern = new RegExp(`^export type ${name} = string$`, "gm")
    const hits = [...out.matchAll(pattern)]
    if (hits.length !== 1) {
      throw new CodegenError(
        `alias override expected exactly 1 \`export type ${name} = string\` in ${schemaFile}, ` +
          `found ${hits.length}. Either the $def was renamed / dropped, or ` +
          `json-schema-to-typescript stopped emitting a bare string alias for it; inspect raw ` +
          `output and update ENTRIES.aliasOverrides.`,
      )
    }
    out = out.replace(pattern, () => `export type ${name} = ${replacement}`)
  }
  return out
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
  let body = stripPermissiveIntersection(entry.schema, `${normalized}\n`)
  if (entry.crossRefs) {
    body = rewriteCrossRefs(entry.schema, body, entry.crossRefs)
  }
  if (entry.aliasOverrides) {
    body = applyAliasOverrides(entry.schema, body, entry.aliasOverrides)
  }

  const banner = HEADER.replace("<file>", entry.schema.replace(/\.json$/, ""))
  return banner + body
}

/** Test-only re-export of rewriteCrossRefs. Not part of the public surface. */
export const rewriteCrossRefsForTest = rewriteCrossRefs

/** Test-only re-export of applyAliasOverrides. Not part of the public surface. */
export const applyAliasOverridesForTest = applyAliasOverrides

/** Every `$defs` key in one schema, for the drift test's brand-coverage assertion. */
export async function readDefNames(schemaFile: string): Promise<string[]> {
  const raw = await readFile(join(SCHEMA_DIR, schemaFile), "utf8")
  const schema = JSON.parse(raw) as { $defs?: Record<string, unknown> }
  return Object.keys(schema.$defs ?? {})
}

/** Generate every schema's TypeScript in-memory. Used by both the CLI and the drift test. */
export async function generateAll(): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of ENTRIES) {
    try {
      result[entry.out] = await generateContent(entry)
    } catch (err: unknown) {
      throw new CodegenError(`Failed to generate ${entry.out} from ${entry.schema}`, {
        cause: err,
      })
    }
  }
  return result
}
