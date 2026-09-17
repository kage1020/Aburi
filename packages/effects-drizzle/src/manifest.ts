import { defineEffectsManifest } from "@aburi/plugin-registry/plugin-input"
import { EFFECTS_DRIZZLE_DERIVED_BY_PREFIX, EFFECTS_DRIZZLE_PLUGIN_NAME } from "./constants"

/** See `defineEffectsManifest` for why `provides` claims no vocabulary of its own. */
export const effectsDrizzleManifest = defineEffectsManifest(
  EFFECTS_DRIZZLE_PLUGIN_NAME,
  EFFECTS_DRIZZLE_DERIVED_BY_PREFIX,
)
