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
  // Loose placeholders to rewrite as re-exports from another generated module. Used for
  // cross-schema $ref-by-description patterns (e.g., diff schema's Symbol/Component/
  // Dependency/SymbolId are deliberately loose and point back to ir schema). Object $defs
  // land as `interface X {}`, string $defs as `type X = string`; both forms are stripped.
  crossRefs?: Record<string, string>
  // Generated `export type X = string` aliases whose right-hand side is replaced. JSON
  // Schema cannot express a nominal type, so the ids that carry a namespace (SymbolId,
  // ComponentId, SliceId) get their brand here rather than in the schema — a `tsType`-style
  // keyword in a frozen v1 document would make strict-mode validators reject the schema
  // itself. Keys must NOT overlap with crossRefs: those aliases are gone by this point.
  aliasOverrides?: Record<string, string>
  // `$defs` whose name ends in `Id` but which deliberately carry no brand. Listing them is
  // what makes the brand table exhaustive: the drift test walks every `*Id` definition and
  // requires it to appear in `aliasOverrides`, in `crossRefs`, or here — so adding a new id
  // to a schema and forgetting to brand it fails the build instead of shipping a bare alias.
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
      // §11: one array holds both endpoint kinds and the kind is recovered from the id
      // shape. The union keeps a bare string out while admitting either id.
      DependencyEndpoint: "SymbolId | ComponentId",
    },
    // `EffectId` is a vocabulary term, not an entity id — it names a kind of side effect,
    // and `x-<plugin>:<action>` values are meant to be written as literals. `LanguageId` is
    // a plugin-declared token that a Symbol id embeds rather than an identifier of its own.
    // Neither can be confused with the ids above, so neither earns a namespace.
    unbrandedIds: ["EffectId", "LanguageId"],
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

  // 1. Strip loose placeholders. Match optional `/** ... */` JSDoc + either
  //    `export interface X {\n}` (object $def) or `export type X = string` (string $def).
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

/**
 * Replace the right-hand side of generated `export type X = string` aliases.
 *
 * An id that owns a namespace — a Symbol id, a Component id, a Slice id — is not
 * interchangeable with an arbitrary string, but JSON Schema has no way to say so: every one
 * of them is `{"type": "string"}` on the wire and json-schema-to-typescript faithfully emits
 * a structural alias that any string satisfies. The nominal part is layered on here, after
 * generation, so the schema files stay expressible in standard JSON Schema 2020-12.
 *
 * Each name MUST match exactly once, for the same reason `rewriteCrossRefs` insists on it: a
 * silently-missed alias leaves the plain `= string` in place, and the drift test would then
 * happily compare one unbranded file against another.
 */
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
    // Callback form: `String.replace` reads `$&`, `` $` ``, `$'` and `$1` in a string
    // replacement, which would silently mangle a right-hand side containing one.
    out = out.replace(pattern, () => `export type ${name} = ${replacement}`)
  }
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
  // crossRefs must run first: it removes the loose local aliases that point at another
  // module (diff's `SymbolId`), which would otherwise be branded here and never re-exported.
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
