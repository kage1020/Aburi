import type { Config, FrameworkHint, HintRule, PluginManifest } from "@aburi/types"
import { ConfigError } from "./errors"

/**
 * Reserved root that consumers must NOT write directly in HintRule.extKind.
 * The loader injects "hint" as the second segment automatically (config.md §8.3.1), so a
 * user-written `framework:hint:*` would either double-prefix or collide with the auto form.
 * derivedBy has no such reservation: `framework-hint:*` is the legitimate user-written
 * shape (config.md §8 example) and the synthesized plugin owns its parent namespace.
 */
const RESERVED_EXT_KIND_PREFIX = "framework:hint:"

const PLUGIN_SCHEMA = "https://aburi.dev/schema/aburi.plugin.v1.json"

interface NormalizedRule {
  extKind?: string | undefined
  derivedBy?: string | undefined
}

/**
 * Transform every frameworkHints[] entry into a synthesized framework-type PluginManifest.
 *
 * - extKind: `framework:<rest>` → `framework:hint:<rest>` (auto-prefix second segment).
 * - derivedBy: written verbatim by the user; the synthesized plugin only owns the
 *   parent prefix of each value.
 * - frameworks: `[hint.name]`.
 * - name: `hint-<hint.name>`.
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

  const extKindPrefixes = uniqueSortedPrefixes(extKinds, 2)
  const derivedByPrefixes = uniqueSortedPrefixes(derivedBys, 1)

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
 * "framework:acme:controller" → "framework:hint:acme:controller".
 * Splits on ":", inserts "hint" as the second segment, rejoins.
 */
function injectHintSegment(extKind: string): string {
  const segments = extKind.split(":")
  segments.splice(1, 0, "hint")
  return segments.join(":")
}

/**
 * Derive each value's parent namespace (all but the last segment) when it has multiple
 * segments, else the value itself. Deduplicates and sorts lexicographically.
 *
 * `minSegments` enforces the schema's minimum prefix length: extKindPrefixes require 2
 * segments, derivedByPrefixes allow 1. Pre-normalized inputs always satisfy these (the
 * full extKind already has ≥3 segments after hint injection, so its parent has ≥2).
 */
function uniqueSortedPrefixes(values: Set<string>, minSegments: number): string[] {
  const prefixes = new Set<string>()
  for (const value of values) {
    const segments = value.split(":")
    const parent = segments.length > minSegments ? segments.slice(0, -1).join(":") : value
    prefixes.add(parent)
  }
  return [...prefixes].sort()
}
