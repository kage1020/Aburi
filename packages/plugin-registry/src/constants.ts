export const RESERVED_NAMESPACES = ["core", "aburi", "_", "framework:hint"] as const

export type ReservedNamespace = (typeof RESERVED_NAMESPACES)[number]

/** The reserved namespace a `frameworkHints` entry's synthesised manifest owns a part of. */
export const HINT_NAMESPACE: ReservedNamespace = "framework:hint"

export const TYPE_NAMESPACE_RULES = {
  lang: {
    allowedExtKindRoots: ["fp", "oop", "meta"] as const,
    canOwnEffects: false,
    canOwnFrameworks: false,
  },
  effects: {
    allowedExtKindRoots: [] as const,
    canOwnEffects: true,
    canOwnFrameworks: false,
  },
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

export function isReserved(value: string): boolean {
  return RESERVED_NAMESPACES.some((reserved) => isUnderPrefix(value, reserved))
}
