/**
 * Plugin identity, kept in a leaf module so `classify.ts`, `imports.ts`, and `manifest.ts`
 * can all reach it without importing each other. Putting these next to the classifier
 * instead would make `imports.ts → classify.ts → imports.ts` a cycle.
 */

/**
 * Package-relative plugin name. Doubles as the prefix of every thrown message, so a caught
 * exception names the plugin that rejected the input. `manifest.ts` declares the same
 * string as `name`.
 */
export const EFFECTS_PRISMA_PLUGIN_NAME = "effects-prisma" as const

/**
 * Shared derivedBy namespace. `manifest.ts` imports this same const for its
 * `derivedByPrefixes` entry, so the classifier's tag builder and the registry
 * declaration cannot drift.
 */
export const EFFECTS_PRISMA_DERIVED_BY_PREFIX = "effects-plugin:prisma" as const
