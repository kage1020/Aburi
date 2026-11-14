import {
  defineEffectsManifest,
  type EffectsPluginManifest,
} from "@aburi/plugin-registry/plugin-input"
import { EFFECTS_DRIZZLE_DERIVED_BY_PREFIX, EFFECTS_DRIZZLE_PLUGIN_NAME } from "./constants"

export const effectsDrizzleManifest: EffectsPluginManifest<
  typeof EFFECTS_DRIZZLE_PLUGIN_NAME,
  typeof EFFECTS_DRIZZLE_DERIVED_BY_PREFIX
> = defineEffectsManifest(EFFECTS_DRIZZLE_PLUGIN_NAME, EFFECTS_DRIZZLE_DERIVED_BY_PREFIX)
