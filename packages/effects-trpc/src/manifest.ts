import {
  defineEffectsManifest,
  type EffectsPluginManifest,
} from "@aburi/plugin-registry/plugin-input"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX, EFFECTS_TRPC_PLUGIN_NAME } from "./constants"

export const effectsTrpcManifest: EffectsPluginManifest<
  typeof EFFECTS_TRPC_PLUGIN_NAME,
  typeof EFFECTS_TRPC_DERIVED_BY_PREFIX
> = defineEffectsManifest(EFFECTS_TRPC_PLUGIN_NAME, EFFECTS_TRPC_DERIVED_BY_PREFIX)
