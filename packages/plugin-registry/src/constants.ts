// Reservation policy. See docs/design/extension-vocab.md §5.

/**
 * Central-reservation prefixes. No plugin may declare an id or prefix that begins
 * with any of these — they're owned by Aburi core, the runtime, or the user-only
 * frameworkHints tier. Each entry is a literal prefix; matching is "starts with
 * the prefix followed by `:` or end-of-string".
 */
export const RESERVED_NAMESPACES = ["core", "aburi", "_", "framework:hint"] as const

export type ReservedNamespace = (typeof RESERVED_NAMESPACES)[number]

/**
 * Which top-level namespaces each plugin type may own. Schema (`aburi.plugin.v1.json`
 * allOf if/then) already blocks most cross-type leaks; we re-encode the rules here
 * so the registry can give targeted error messages instead of opaque schema failures.
 */
export const TYPE_NAMESPACE_RULES = {
  /** Lang plugins own fp:* / oop:* / meta:*. They never own framework / x-. */
  lang: {
    allowedExtKindRoots: ["fp", "oop", "meta"] as const,
    canOwnEffects: false,
    canOwnFrameworks: false,
  },
  /** Effects plugins own x-<xPrefix>:*. They never own extKinds or frameworks. */
  effects: {
    allowedExtKindRoots: [] as const,
    canOwnEffects: true,
    canOwnFrameworks: false,
  },
  /** Framework plugins own framework:*, plus framework name entries. Never x-, never fp/oop/meta. */
  framework: {
    allowedExtKindRoots: ["framework"] as const,
    canOwnEffects: false,
    canOwnFrameworks: true,
  },
} as const

export type PluginType = keyof typeof TYPE_NAMESPACE_RULES

/**
 * Default xPrefix derivation: strip a leading "effects-" segment from the plugin
 * name. Used when the manifest does not declare xPrefix explicitly. Matches the
 * worked example in extension-vocab.md §3.1: effects-prisma → prisma → x-prisma:*.
 */
export function deriveXPrefix(name: string): string {
  return name.startsWith("effects-") ? name.slice("effects-".length) : name
}

/**
 * Strip-prefix test that respects segment boundaries. Returns true iff `value`
 * equals `prefix` or starts with `prefix + ":"`. Used for both reservation checks
 * and prefix-prefix containment detection. Crucially `"framework:hintsomething"`
 * does NOT count as inside `"framework:hint"` — only `"framework:hint"` itself
 * and `"framework:hint:..."` do.
 */
export function isUnderPrefix(value: string, prefix: string): boolean {
  if (value === prefix) return true
  return value.startsWith(`${prefix}:`)
}

/** True iff `value` falls under any of the central-reserved namespaces. */
export function isReserved(value: string): boolean {
  return RESERVED_NAMESPACES.some((reserved) => isUnderPrefix(value, reserved))
}
