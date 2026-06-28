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

  // 1. Strip empty placeholders. Match optional `/** ... */` JSDoc + `export interface X {\n}`.
  //    JSDoc inner uses `(?:[^*]|\*(?!\/))*` so it cannot cross `*/` boundaries, otherwise the
  //    non-greedy variant `[\s\S]*?` would backtrack across earlier definitions (e.g. DiffResult's
  //    own JSDoc → Symbol's JSDoc) and delete everything between.
  //
  //    Each name MUST match exactly once. If json-schema-to-typescript ever changes its output
  //    so the placeholder no longer appears (or appears multiple times), we want to fail loudly
  //    here rather than silently leave a colliding local `interface Symbol {}` next to the
  //    re-exported one — that would slip past the drift test.
  for (const name of Object.keys(crossRefs)) {
    const pattern = new RegExp(
      String.raw`(?:\/\*\*(?:[^*]|\*(?!\/))*\*\/\s*)?export interface ${name}\s*\{\s*\}\s*\n`,
      "g",
    )
    const hits = [...out.matchAll(pattern)]
    if (hits.length !== 1) {
      throw new CodegenError(
        `crossRef rewrite expected exactly 1 empty placeholder \`interface ${name} {}\` in ` +
          `${schemaFile}, found ${hits.length}. json-schema-to-typescript output format may ` +
          `have changed; inspect raw output and update rewriteCrossRefs().`,
      )
    }
    out = out.replace(pattern, "")
  }

  // 2. Group imports/re-exports by source module so duplicate imports collapse.
  //    `export type {} from "./mod"` re-exports names but does NOT bring them into local
  //    scope. Emit both `import type` (for local refs like SymbolAdded.symbol: Symbol) and
  //    `export type` (so consumers of the diff barrel see them).
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

/**
 * json-schema-to-typescript wraps types whose schema has `allOf` / `if-then-else`
 * structure into `({ [k: string]: unknown | undefined } & { ...real fields... })`.
 * Schema-wise these declare `additionalProperties: false`, so the wrapping index
 * signature is a false positive: it defeats `noUncheckedIndexedAccess` and lets
 * consumers silently add undeclared keys. Strip the wrapper so `tsc` sees what the
 * schema actually says.
 *
 * Legitimate inner `Record<string, X>` style index signatures (e.g. config
 * `pluginOptions: { [k: string]: unknown }`) are NOT touched — only the very specific
 * outer `export type X = ({ ... } & { ... })` wrap pattern matches.
 */
const WRAPPER_PATTERN =
  /^export type (\w+) = \(\{\n\[k: string\]: unknown \| undefined\n\} & \{\n([\s\S]*?)\n\}\)$/gm

function stripPermissiveIntersection(schemaFile: string, source: string): string {
  let out = source
  for (const match of [...source.matchAll(WRAPPER_PATTERN)]) {
    const [whole, name, inner] = match
    if (name === undefined || inner === undefined) continue
    out = out.replace(whole, `export interface ${name} {\n${inner}\n}`)
  }
  // Re-run the pattern on the output. If any wrapper survives, the strip silently
  // missed an occurrence and the resulting interface would still admit any extra key.
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

async function generateContent(entry: SchemaEntry): Promise<string> {
  const schemaPath = join(SCHEMA_DIR, entry.schema)
  const raw = await readFile(schemaPath, "utf8")
  const schema = JSON.parse(raw) as Record<string, unknown>
  // json-schema-to-typescript prefers schema.title over the rootName argument when
  // computing the root type name. Force-rewrite title so the generated root type matches
  // the public API contract documented in lang-plugin.md §4, ir-schema.md, etc.
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

  const banner = HEADER.replace("<file>", entry.schema.replace(/\.json$/, ""))
  return banner + body
}

/** Test-only re-export of rewriteCrossRefs. Not part of the public surface. */
export const rewriteCrossRefsForTest = rewriteCrossRefs

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
