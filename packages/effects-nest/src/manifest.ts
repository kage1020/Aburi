import type { EffectsManifest } from "@aburi/types"
import { EFFECTS_NEST_DERIVED_BY_PREFIX } from "./classify"

/**
 * Manifest for `@aburi/effects-nest`. `as const satisfies EffectsManifest` keeps every
 * literal narrow so the registry sees the exact shape.
 *
 * The plugin returns the core-owned `event.publish` effect id from `classify()`; per
 * extension-vocab.md §5.1 core vocab lives in the reserved namespace and MUST NOT
 * appear in a plugin's `provides.effects`. The plugin's own `x-nest:*` namespace has
 * no v0.1 bindings — NestJS lifecycle hooks and CQRS-style command / query events are
 * candidates for future extension. `derivedByPrefixes` shares its literal with the
 * classifier's tag builder so both stay in lockstep across edits.
 *
 * `frameworks` / `extKinds` are empty by contract (an effects plugin cannot claim
 * either); the NestJS framework recognition sits in `@aburi/framework-nestjs`.
 */
export const effectsNestManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "effects-nest",
  version: "0.0.0",
  type: "effects",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [EFFECTS_NEST_DERIVED_BY_PREFIX],
    frameworks: [],
  },
} as const satisfies EffectsManifest
