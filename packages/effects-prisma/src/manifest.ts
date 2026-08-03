import type { EffectsManifest } from "@aburi/types"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"

/**
 * Manifest for `@aburi/effects-prisma`. `as const satisfies EffectsManifest` keeps
 * every literal narrow so downstream registry checks see the exact shape.
 *
 * The plugin returns core-owned effect ids (`db.read` / `db.write` / `db.transaction`)
 * from `classify()`; per extension-vocab.md §5.1 core vocab lives in the reserved
 * namespace and MUST NOT appear in a plugin's `provides.effects`. The plugin's own
 * `x-prisma:*` namespace currently has no bindings — model-specific effects would sit there
 * once introduced. `derivedByPrefixes` shares its literal with the classifier's tag
 * builder so both stay in lockstep across edits.
 */
export const effectsPrismaManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: EFFECTS_PRISMA_PLUGIN_NAME,
  version: "0.0.0",
  type: "effects",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [EFFECTS_PRISMA_DERIVED_BY_PREFIX],
    frameworks: [],
  },
} as const satisfies EffectsManifest
