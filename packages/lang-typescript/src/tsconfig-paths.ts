import { readFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { ImportResolver, ImportResolverContext } from "@aburi/types"
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser"

const CONFIG_FILE_NAMES = ["tsconfig.json", "jsconfig.json"]
const CONFIG_DIR = `\${configDir}`

interface Declared<T> {
  readonly value: T
  /** The directory of the config that declares the option, which a relative value resolves against. */
  readonly dir: string
}

interface CompilerPaths {
  baseUrl?: Declared<string>
  paths?: Declared<Readonly<Record<string, unknown>>>
}

interface RawConfig {
  readonly extends: readonly string[]
  readonly compilerOptions: Readonly<Record<string, unknown>>
}

interface PathPattern {
  readonly prefix: string
  /** `null` for a key without a `*`, which matches only itself. */
  readonly suffix: string | null
  readonly substitutions: readonly string[]
}

interface PathMapping {
  readonly leafDir: string
  readonly baseUrl: string | null
  readonly pathsBase: string | null
  readonly patterns: readonly PathPattern[]
}

export function createTsconfigResolver(ctx: ImportResolverContext): ImportResolver {
  const root = resolve(ctx.workspaceRoot)
  const reads = new Map<string, Promise<RawConfig | null>>()
  const scopes = new Map<string, Promise<string | null>>()
  const mappings = new Map<string, Promise<PathMapping>>()

  const read = (path: string): Promise<RawConfig | null> => {
    let config = reads.get(path)
    if (config === undefined) {
      config = readConfig(path, (problem) =>
        ctx.log.warn(
          `${displayPath(root, path)} ${problem}, so the path aliases it declares are not resolved.`,
        ),
      )
      reads.set(path, config)
    }
    return config
  }

  const nearestConfig = (directory: string): Promise<string | null> => {
    let found = scopes.get(directory)
    if (found === undefined) {
      found = (async () => {
        for (const name of CONFIG_FILE_NAMES) {
          const path = join(directory, name)
          if ((await read(path)) !== null) return path
        }
        const parent = dirname(directory)
        return directory === root || !isInside(root, parent) ? null : nearestConfig(parent)
      })()
      scopes.set(directory, found)
    }
    return found
  }

  const mappingOf = (configPath: string): Promise<PathMapping> => {
    let mapping = mappings.get(configPath)
    if (mapping === undefined) {
      mapping = compilerPaths(configPath, [], read).then((options) =>
        buildMapping(options, dirname(configPath)),
      )
      mappings.set(configPath, mapping)
    }
    return mapping
  }

  return {
    async resolve(specifier, fromFile) {
      const directory = dirname(join(root, fromFile))
      if (!isInside(root, directory)) return []
      const configPath = await nearestConfig(directory)
      if (configPath === null) return []
      return mappedPaths(await mappingOf(configPath), specifier)
        .filter((path) => isInside(root, path))
        .map((path) => relative(root, path).split(sep).join("/"))
    },
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function displayPath(root: string, path: string): string {
  return isInside(root, path) ? relative(root, path).split(sep).join("/") : path
}

async function readConfig(
  path: string,
  warn: (problem: string) => void,
): Promise<RawConfig | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return null
  }
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  const first = errors[0]
  if (first !== undefined) {
    warn(`is not valid JSON (${printParseErrorCode(first.error)} at offset ${first.offset})`)
    return { extends: [], compilerOptions: {} }
  }
  const config = isRecord(value) ? value : {}
  const written = config.extends
  const extendsList =
    typeof written === "string" ? [written] : Array.isArray(written) ? written : []
  return {
    extends: extendsList.filter((entry): entry is string => typeof entry === "string"),
    compilerOptions: isRecord(config.compilerOptions) ? config.compilerOptions : {},
  }
}

// Each config in `extends` overrides the ones before it and the extending config overrides them
// all, option by option, the way `tsc` merges them.
async function compilerPaths(
  configPath: string,
  chain: readonly string[],
  read: (path: string) => Promise<RawConfig | null>,
): Promise<CompilerPaths> {
  const config = await read(configPath)
  if (config === null) return {}
  const dir = dirname(configPath)
  const merged: CompilerPaths = {}
  for (const entry of config.extends) {
    const base = await locateExtended(entry, dir, read)
    if (base === null || base === configPath || chain.includes(base)) continue
    Object.assign(merged, await compilerPaths(base, [...chain, configPath], read))
  }
  const { baseUrl, paths } = config.compilerOptions
  if (typeof baseUrl === "string") merged.baseUrl = { value: baseUrl, dir }
  if (isRecord(paths)) merged.paths = { value: paths, dir }
  return merged
}

// A package's config is looked up in `node_modules` as `<package>/<path>`, `<package>/<path>.json`
// or `<package>/tsconfig.json`; its `package.json` `exports` and `tsconfig` fields are not read.
async function locateExtended(
  entry: string,
  dir: string,
  read: (path: string) => Promise<RawConfig | null>,
): Promise<string | null> {
  const relativeEntry = entry.startsWith("./") || entry.startsWith("../") || isAbsolute(entry)
  const candidates: string[] = []
  if (relativeEntry) {
    const path = resolve(dir, entry)
    candidates.push(path)
    if (extname(path) !== ".json") candidates.push(`${path}.json`)
  } else {
    for (let at = dir; ; at = dirname(at)) {
      const path = join(at, "node_modules", entry)
      candidates.push(path, `${path}.json`, join(path, "tsconfig.json"))
      if (dirname(at) === at) break
    }
  }
  for (const candidate of candidates) {
    if ((await read(candidate)) !== null) return candidate
  }
  return null
}

function buildMapping(options: CompilerPaths, leafDir: string): PathMapping {
  const baseUrl =
    options.baseUrl === undefined
      ? null
      : optionPath(options.baseUrl.value, options.baseUrl.dir, leafDir)
  const pathsBase = baseUrl ?? options.paths?.dir ?? null
  const patterns: PathPattern[] = []
  for (const [key, value] of Object.entries(options.paths?.value ?? {})) {
    if (!Array.isArray(value)) continue
    const substitutions = value.filter(
      (entry): entry is string => typeof entry === "string" && countStars(entry) <= 1,
    )
    const stars = countStars(key)
    if (stars > 1) continue
    const star = key.indexOf("*")
    patterns.push(
      stars === 0
        ? { prefix: key, suffix: null, substitutions }
        : { prefix: key.slice(0, star), suffix: key.slice(star + 1), substitutions },
    )
  }
  return { leafDir, baseUrl, pathsBase, patterns }
}

function mappedPaths(mapping: PathMapping, specifier: string): string[] {
  const out: string[] = []
  const match = matchPattern(mapping.patterns, specifier)
  if (match !== null && mapping.pathsBase !== null) {
    for (const substitution of match.pattern.substitutions) {
      const written =
        match.star === null ? substitution : substitution.replace("*", () => match.star ?? "")
      out.push(optionPath(written, mapping.pathsBase, mapping.leafDir))
    }
  }
  if (mapping.baseUrl !== null) out.push(resolve(mapping.baseUrl, specifier))
  return out
}

// An exact key wins outright; among wildcard keys the longest prefix does, as in `tsc`.
function matchPattern(
  patterns: readonly PathPattern[],
  specifier: string,
): { pattern: PathPattern; star: string | null } | null {
  let best: PathPattern | null = null
  for (const pattern of patterns) {
    if (pattern.suffix === null) {
      if (pattern.prefix === specifier) return { pattern, star: null }
      continue
    }
    const fits =
      specifier.length >= pattern.prefix.length + pattern.suffix.length &&
      specifier.startsWith(pattern.prefix) &&
      specifier.endsWith(pattern.suffix)
    if (fits && (best === null || pattern.prefix.length > best.prefix.length)) best = pattern
  }
  if (best === null || best.suffix === null) return null
  return {
    pattern: best,
    star: specifier.slice(best.prefix.length, specifier.length - best.suffix.length),
  }
}

// `${configDir}` stands for the directory of the config the file is compiled under, whichever
// config in the `extends` chain wrote it.
function optionPath(value: string, declaredDir: string, leafDir: string): string {
  return value.startsWith(CONFIG_DIR)
    ? join(leafDir, value.slice(CONFIG_DIR.length))
    : resolve(declaredDir, value)
}

function countStars(text: string): number {
  return text.split("*").length - 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
