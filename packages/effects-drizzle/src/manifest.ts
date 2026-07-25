import type { EffectsManifest } from "@aburi/types"
import { EFFECTS_DRIZZLE_DERIVED_BY_PREFIX } from "./classify"

/**
 * Manifest for `@aburi/effects-drizzle`. `as const satisfies EffectsManifest` keeps
 * every literal narrow so downstream registry checks see the exact shape.
 *
 * The plugin returns core-owned effect ids (`db.read` / `db.write` / `db.transaction`)
 * from `classify()`; per extension-vocab.md §5.1 core vocab lives in the reserved
 * namespace and MUST NOT appear in a plugin's `provides.effects`. The plugin's own
 * `x-drizzle:*` namespace currently has no bindings — driver-specific effects (e.g.
 * raw SQL disambiguation) would sit there once introduced. `xPrefix` is omitted so the
 * registry derives it from `name` by stripping the leading `effects-` (yielding
 * `"drizzle"`); every future `x-drizzle:*` id lives under that owned root.
 * `derivedByPrefixes` shares its literal with the classifier's tag builder so both stay
 * in lockstep across edits.
 */
export const effectsDrizzleManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "effects-drizzle",
  version: "0.0.0",
  type: "effects",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [EFFECTS_DRIZZLE_DERIVED_BY_PREFIX],
    frameworks: [],
  },
} as const satisfies EffectsManifest
