import {
  defineEffectsManifest,
  type EffectsPluginManifest,
} from "@aburi/plugin-registry/plugin-input"
import { EFFECTS_NEST_DERIVED_BY_PREFIX, EFFECTS_NEST_PLUGIN_NAME } from "./constants"

export const effectsNestManifest: EffectsPluginManifest<
  typeof EFFECTS_NEST_PLUGIN_NAME,
  typeof EFFECTS_NEST_DERIVED_BY_PREFIX
> = defineEffectsManifest(EFFECTS_NEST_PLUGIN_NAME, EFFECTS_NEST_DERIVED_BY_PREFIX)
