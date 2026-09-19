// Plugin identity, in a leaf module so `classify.ts`, `imports.ts` and `manifest.ts` can all
// reach it without importing each other.

/** Plugin name: the manifest's `name` and the prefix of every thrown message. */
export const EFFECTS_PRISMA_PLUGIN_NAME = "effects-prisma" as const

/** derivedBy namespace shared by the classifier's tag builder and the manifest. */
export const EFFECTS_PRISMA_DERIVED_BY_PREFIX = "effects-plugin:prisma" as const
