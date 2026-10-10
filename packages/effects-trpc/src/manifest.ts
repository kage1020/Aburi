import { defineEffectsManifest } from "@aburi/plugin-registry/plugin-input"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX, EFFECTS_TRPC_PLUGIN_NAME } from "./constants"

export const effectsTrpcManifest = defineEffectsManifest(
  EFFECTS_TRPC_PLUGIN_NAME,
  EFFECTS_TRPC_DERIVED_BY_PREFIX,
)
