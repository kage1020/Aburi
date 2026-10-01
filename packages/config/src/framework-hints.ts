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

/**
 * Reserved root that consumers must NOT write directly in HintRule.extKind. The loader
 * always injects "hint" as the second segment, so a user who already wrote "framework:hint:*"
 * would either double-prefix or collide with another hint entry's auto-derived prefix.
 * derivedBy has no equivalent reservation: "framework-hint:*" (note the hyphen) is the
 * legitimate user-written shape and the synthesized plugin owns its parent namespace.
 */
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

/**
 * Build the framework plugin each frameworkHints[] entry stands for (`config.md` §8.3): its
 * synthesized manifest, and the rules applied to every Symbol in the framework stage.
 *
 * Manifest:
 * - `extKind: "framework:<vendor>:<rest>"` → `"framework:hint:<vendor>:<rest>"`. The schema
 *   guarantees at least three segments, so the post-injection value has at least four and
 *   its parent prefix has at least three (`framework:hint:<vendor>`). Two entries that write
 *   the same vendor derive the same prefix, which the registry refuses (`config.md` §8.4).
 * - `derivedBy` is taken verbatim. The synthesized plugin claims ownership of each value's
 *   parent prefix (or the value itself when single-segment).
 * - `frameworks: [hint.name]`.
 * - `name: "hint-<hint.name>"`.
 *
 * Rules (`config.md` §8.1, §8.2):
 * - A decorator rule applies to a Symbol carrying a decorator of that name, matched on the
 *   leaf, so `@acme.AcmeController()` meets `AcmeController` as well. Its `boundary` is filed
 *   under the decorator as written, which is how the framework stage matches it back.
 * - A class-name rule applies to a class whose name matches the glob (`*` any run of
 *   characters, `?` one), and has no `boundary` to give.
 * - Decorator rules come first, in the order the decorators are written, then class-name
 *   rules in config order. The first `extKind` among them is the Symbol's; every `derivedBy`
 *   is appended. `drop` goes through `symbolDropHint`, since a drop is not a classification.
 */
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
      // A boundary decorator overrides every Category-B rule (`drop-list.md`), a hint's too.
      if (symbol.decorators.some((d) => d.boundary)) return null
      const hit = hits(symbol).find(({ rule }) => rule.drop)
      if (hit === undefined) return null
      const what = hit.rule.source === "decorator" ? `@${hit.rule.key}` : `class ${hit.rule.key}`
      return { reason: `frameworkHints "${hint.name}": ${what}`, category: "B" }
    },
  }
}

/**
 * `null` when the rules that apply give nothing to merge: no rule at all, or rules that only
 * drop. A non-null answer ends the framework stage for the Symbol, so an empty one would take
 * the turn from a later `frameworkHints` entry for nothing.
 */
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

/**
 * "framework:acme:controller" → "framework:hint:acme:controller". Splits on ":", inserts
 * "hint" as the second segment, rejoins. The schema guarantees extKind starts with
 * "framework:" and has at least three segments, so the result has at least four and the
 * caller can safely derive its parent prefix.
 */
function injectHintSegment(extKind: string): string {
  const segments = extKind.split(":")
  segments.splice(1, 0, "hint")
  return segments.join(":")
}

/**
 * Drop the last segment of each value (the leaf id) to obtain the ownership prefix; values
 * with a single segment are kept as-is so derivedBy "myhint" still produces a valid one-
 * segment prefix. Deduplicates and sorts lexicographically.
 */
function uniqueSortedParentPrefixes(values: Set<string>): string[] {
  const prefixes = new Set<string>()
  for (const value of values) {
    const segments = value.split(":")
    const parent = segments.length > 1 ? segments.slice(0, -1).join(":") : value
    prefixes.add(parent)
  }
  return [...prefixes].sort()
}
