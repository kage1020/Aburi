import {
  defineEffectsManifest,
  type EffectsPluginManifest,
} from "@aburi/plugin-registry/plugin-input"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"

export const effectsPrismaManifest: EffectsPluginManifest<
  typeof EFFECTS_PRISMA_PLUGIN_NAME,
  typeof EFFECTS_PRISMA_DERIVED_BY_PREFIX
> = defineEffectsManifest(EFFECTS_PRISMA_PLUGIN_NAME, EFFECTS_PRISMA_DERIVED_BY_PREFIX)
