import { defineEffectsManifest } from "@aburi/plugin-registry/plugin-input"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"

/** See `defineEffectsManifest` for why `provides` claims no vocabulary of its own. */
export const effectsPrismaManifest = defineEffectsManifest(
  EFFECTS_PRISMA_PLUGIN_NAME,
  EFFECTS_PRISMA_DERIVED_BY_PREFIX,
)
