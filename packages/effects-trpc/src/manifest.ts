import { defineEffectsManifest } from "@aburi/plugin-registry/plugin-input"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX, EFFECTS_TRPC_PLUGIN_NAME } from "./constants"

/**
 * See `defineEffectsManifest` for why `provides` claims no vocabulary of its own. The
 * empty `extKinds` is also why the server-side router surface — which would need
 * `framework:trpc:*` extKinds to become a Boundary — is out of scope here; the `trpc`
 * framework *name* is detected core-side from a `@trpc/server` dependency
 * (component-detect.md).
 */
export const effectsTrpcManifest = defineEffectsManifest(
  EFFECTS_TRPC_PLUGIN_NAME,
  EFFECTS_TRPC_DERIVED_BY_PREFIX,
)
