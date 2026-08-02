/**
 * Plugin identity, kept in a leaf module so `classify.ts`, `emitters.ts`, and `manifest.ts`
 * can all reach it without importing each other. Putting these next to the classifier
 * instead would make `emitters.ts → classify.ts → emitters.ts` a cycle.
 */

/**
 * Package-relative plugin name. Doubles as the prefix of every thrown message, so a caught
 * exception names the plugin that rejected the input. `manifest.ts` declares the same
 * string as `name`.
 */
export const EFFECTS_NEST_PLUGIN_NAME = "effects-nest" as const

/**
 * Shared derivedBy namespace. `manifest.ts` imports this same const for its
 * `derivedByPrefixes` entry, so the classifier's tag builder and the registry
 * declaration cannot drift.
 */
export const EFFECTS_NEST_DERIVED_BY_PREFIX = "effects-plugin:nest" as const
