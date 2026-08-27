import type { Config, FrameworkHint, HintRule, PluginManifest } from "@aburi/types"
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

interface NormalizedRule {
  extKind?: string | undefined
  derivedBy?: string | undefined
}

/**
 * Transform every frameworkHints[] entry into a synthesized framework-type PluginManifest
 * the registry can register without any plugin code.
 *
 * Transformation summary:
 * - `extKind: "framework:<vendor>:<rest>"` → `"framework:hint:<vendor>:<rest>"`. The schema
 *   guarantees at least three segments, so the post-injection value has at least four and
 *   its parent prefix has at least three (`framework:hint:<vendor>`), which is unique per
 *   hint name and cannot collide with another hint's prefix.
 * - `derivedBy` is taken verbatim. The synthesized plugin claims ownership of each value's
 *   parent prefix (or the value itself when single-segment).
 * - `frameworks: [hint.name]`.
 * - `name: "hint-<hint.name>"`.
 */
export function normalizeFrameworkHints(config: Config): PluginManifest[] {
  const out: PluginManifest[] = []
  for (const hint of config.frameworkHints ?? []) {
    out.push(buildSyntheticPlugin(hint))
  }
  return out
}

function buildSyntheticPlugin(hint: FrameworkHint): PluginManifest {
  const extKinds = new Set<string>()
  const derivedBys = new Set<string>()

  for (const rule of iterateRules(hint)) {
    const normalized = normalizeRule(rule, hint.name)
    if (normalized.extKind !== undefined) extKinds.add(normalized.extKind)
    if (normalized.derivedBy !== undefined) derivedBys.add(normalized.derivedBy)
  }

  const extKindPrefixes = uniqueSortedParentPrefixes(extKinds)
  const derivedByPrefixes = uniqueSortedParentPrefixes(derivedBys)

  return {
    $schema: PLUGIN_SCHEMA,
    name: `hint-${hint.name}`,
    version: "0.0.0",
    type: "framework",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes,
      derivedByPrefixes,
      frameworks: [hint.name],
    },
  }
}

function* iterateRules(hint: FrameworkHint): Iterable<HintRule> {
  for (const rule of Object.values(hint.decorators ?? {})) {
    if (rule) yield rule
  }
  for (const rule of Object.values(hint.classNamePatterns ?? {})) {
    if (rule) yield rule
  }
}

function normalizeRule(rule: HintRule, hintName: string): NormalizedRule {
  const normalized: NormalizedRule = {}

  if (rule.extKind !== undefined) {
    if (rule.extKind.startsWith(RESERVED_EXT_KIND_PREFIX)) {
      throw new ConfigError(
        `frameworkHints[name=${hintName}] extKind "${rule.extKind}" writes the reserved "framework:hint:" namespace directly; remove the "hint:" segment and let the loader add it`,
        { code: "reserved-namespace", value: rule.extKind },
      )
    }
    normalized.extKind = injectHintSegment(rule.extKind)
  }

  if (rule.derivedBy !== undefined) {
    normalized.derivedBy = rule.derivedBy
  }

  return normalized
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
