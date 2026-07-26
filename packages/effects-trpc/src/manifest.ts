import type { EffectsManifest } from "@aburi/types"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX } from "./classify"

/**
 * Manifest for `@aburi/effects-trpc`. `as const satisfies EffectsManifest` keeps every
 * literal narrow so downstream registry checks see the exact shape.
 *
 * The plugin returns the core-owned effect id `network.rpc` from `classify()`; per
 * extension-vocab.md §5.1 core vocab lives in the reserved namespace and MUST NOT appear
 * in a plugin's `provides.effects`. The plugin's own `x-trpc:*` namespace currently has no
 * bindings — a transport-specific or streaming-specific id would sit there once the
 * distinction becomes statically decidable. `xPrefix` is omitted so the registry derives it
 * from `name` by stripping the leading `effects-` (yielding `"trpc"`); every future
 * `x-trpc:*` id lives under that owned root.
 *
 * `extKinds` / `extKindPrefixes` / `frameworks` are empty and must stay that way: a
 * `type: "effects"` manifest declaring any of them is a schema validation error
 * (extension-vocab.md §6.1). That constraint is exactly why the server-side router surface
 * — which needs `framework:trpc:*` extKinds to become a Boundary — is out of scope for this
 * package. The `trpc` framework *name* is already detected core-side from a `@trpc/server`
 * dependency (component-detect.md §4.5) and lands in `Component.frameworks[]` independently.
 *
 * `derivedByPrefixes` shares its literal with the classifier's tag builder so both stay in
 * lockstep across edits.
 */
export const effectsTrpcManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "effects-trpc",
  version: "0.0.0",
  type: "effects",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [EFFECTS_TRPC_DERIVED_BY_PREFIX],
    frameworks: [],
  },
} as const satisfies EffectsManifest
