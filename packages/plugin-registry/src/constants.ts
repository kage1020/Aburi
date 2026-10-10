export const RESERVED_NAMESPACES = ["core", "aburi", "_", "framework:hint"] as const

export type ReservedNamespace = (typeof RESERVED_NAMESPACES)[number]

/** The reserved namespace a `frameworkHints` entry's synthesised manifest owns a part of. */
export const HINT_NAMESPACE: ReservedNamespace = "framework:hint"

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

export function deriveXPrefix(name: string): string {
  return name.startsWith("effects-") ? name.slice("effects-".length) : name
}

export function isUnderPrefix(value: string, prefix: string): boolean {
  if (value === prefix) return true
  return value.startsWith(`${prefix}:`)
}

/** True iff `value` falls under any of the central-reserved namespaces. */
export function isReserved(value: string): boolean {
  return RESERVED_NAMESPACES.some((reserved) => isUnderPrefix(value, reserved))
}
