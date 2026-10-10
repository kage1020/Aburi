import type {
  Config,
  Decorator,
  DropHint,
  FrameworkHint,
  FrameworkManifest,
  FrameworkPlugin,
  HintRule,
  PluginManifest,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { ConfigError } from "./errors"

const RESERVED_EXT_KIND_PREFIX = "framework:hint:"

const PLUGIN_SCHEMA = "https://aburi.kage1020.com/schema/aburi.plugin.v1.json"

/** One rule as the hint plugin applies it, its `extKind` already moved under `framework:hint:`. */
interface CompiledRule {
  /** What the rule is filed under in the config: a decorator name or a class-name glob. */
  key: string
  source: "decorator" | "class name"
  boundary: boolean | undefined
  extKind: string | undefined
  derivedBy: string | undefined
  drop: boolean
}

interface ClassNameRule extends CompiledRule {
  matcher: RegExp
}

/** A rule that applies to a Symbol, and the decorator it applies through when it has one. */
interface RuleHit {
  rule: CompiledRule
  decorator: Decorator | null
}

export function frameworkHintPlugins(config: Config): FrameworkPlugin[] {
  return (config.frameworkHints ?? []).map(buildHintPlugin)
}

/** The manifests of `frameworkHintPlugins`, for a caller that only registers vocabulary. */
export function normalizeFrameworkHints(config: Config): PluginManifest[] {
  return frameworkHintPlugins(config).map((plugin) => plugin.manifest)
}

function buildHintPlugin(hint: FrameworkHint): FrameworkPlugin {
  const decoratorRules = new Map<string, CompiledRule>()
  for (const [name, rule] of Object.entries(hint.decorators ?? {})) {
    if (rule) decoratorRules.set(name, compileRule(name, "decorator", rule, hint.name))
  }
  const classNameRules: ClassNameRule[] = []
  for (const [pattern, rule] of Object.entries(hint.classNamePatterns ?? {})) {
    if (!rule) continue
    classNameRules.push({
      ...compileRule(pattern, "class name", rule, hint.name),
      boundary: undefined,
      matcher: globToRegExp(pattern),
    })
  }

  const hits = (symbol: SymbolCandidate): RuleHit[] => {
    const out: RuleHit[] = []
    for (const decorator of symbol.decorators) {
      const rule = decoratorRules.get(decorator.name)
      if (rule !== undefined) out.push({ rule, decorator })
    }
    if (symbol.kind === "class") {
      const name = leafName(symbol.name)
      for (const rule of classNameRules) {
        if (rule.matcher.test(name)) out.push({ rule, decorator: null })
      }
    }
    return out
  }

  return {
    manifest: synthesizeManifest(hint.name, [...decoratorRules.values(), ...classNameRules]),
    async init() {},
    classifySymbol: (symbol) => classify(hits(symbol)),
    symbolDropHint(symbol): DropHint | null {
      // A boundary decorator overrides every Category-B rule, a hint's too.
      if (symbol.decorators.some((d) => d.boundary)) return null
      const hit = hits(symbol).find(({ rule }) => rule.drop)
      if (hit === undefined) return null
      const what = hit.rule.source === "decorator" ? `@${hit.rule.key}` : `class ${hit.rule.key}`
      return { reason: `frameworkHints "${hint.name}": ${what}`, category: "B" }
    },
  }
}

function classify(hits: readonly RuleHit[]): SymbolClassification | null {
  let extKind: string | undefined
  const derivedBy: string[] = []
  const boundaries: Record<string, boolean> = {}
  let hasBoundary = false
  for (const { rule, decorator } of hits) {
    extKind ??= rule.extKind
    if (rule.derivedBy !== undefined && !derivedBy.includes(rule.derivedBy)) {
      derivedBy.push(rule.derivedBy)
    }
    if (decorator !== null && rule.boundary !== undefined) {
      boundaries[writtenForm(decorator)] = rule.boundary
      hasBoundary = true
    }
  }
  if (extKind === undefined && derivedBy.length === 0 && !hasBoundary) return null
  return {
    ...(extKind === undefined ? {} : { extKind }),
    ...(hasBoundary ? { decoratorBoundaries: boundaries } : {}),
    // The framework stage splits on ";" (`mergeDerivedBy` in @aburi/core).
    derivedBy: derivedBy.join(";"),
  }
}

/** The key `SymbolClassification.decoratorBoundaries` is read under: receiver included. */
function writtenForm(decorator: Decorator): string {
  return decorator.qualifier === undefined
    ? decorator.name
    : `${decorator.qualifier}.${decorator.name}`
}

/** A qualified name's last segment: `Outer.FooHandler` is matched as `FooHandler`. */
function leafName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1)
}

/** `*` any run of characters, `?` exactly one, everything else itself; anchored at both ends. */
function globToRegExp(glob: string): RegExp {
  let source = ""
  for (const char of glob) {
    if (char === "*") source += ".*"
    else if (char === "?") source += "."
    else source += char.replace(/[\\^$.+()|[\]{}]/g, "\\$&")
  }
  return new RegExp(`^${source}$`, "u")
}

function compileRule(
  key: string,
  source: CompiledRule["source"],
  rule: HintRule,
  hintName: string,
): CompiledRule {
  return {
    key,
    source,
    boundary: rule.boundary,
    extKind: rule.extKind === undefined ? undefined : hintExtKind(rule.extKind, hintName),
    derivedBy: rule.derivedBy,
    drop: rule.drop === true,
  }
}

function synthesizeManifest(hintName: string, rules: readonly CompiledRule[]): FrameworkManifest {
  const extKinds = new Set<string>()
  const derivedBys = new Set<string>()
  for (const rule of rules) {
    if (rule.extKind !== undefined) extKinds.add(rule.extKind)
    if (rule.derivedBy !== undefined) derivedBys.add(rule.derivedBy)
  }

  return {
    $schema: PLUGIN_SCHEMA,
    name: `hint-${hintName}`,
    version: "0.0.0",
    type: "framework",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: uniqueSortedParentPrefixes(extKinds),
      derivedByPrefixes: uniqueSortedParentPrefixes(derivedBys),
      frameworks: [hintName],
    },
  }
}

function hintExtKind(extKind: string, hintName: string): string {
  if (extKind.startsWith(RESERVED_EXT_KIND_PREFIX)) {
    throw new ConfigError(
      `frameworkHints[name=${hintName}] extKind "${extKind}" writes the reserved "framework:hint:" namespace directly; remove the "hint:" segment and let the loader add it`,
      { code: "reserved-namespace", value: extKind },
    )
  }
  return injectHintSegment(extKind)
}

function injectHintSegment(extKind: string): string {
  const segments = extKind.split(":")
  segments.splice(1, 0, "hint")
  return segments.join(":")
}

function uniqueSortedParentPrefixes(values: Set<string>): string[] {
  const prefixes = new Set<string>()
  for (const value of values) {
    const segments = value.split(":")
    const parent = segments.length > 1 ? segments.slice(0, -1).join(":") : value
    prefixes.add(parent)
  }
  return [...prefixes].sort()
}
