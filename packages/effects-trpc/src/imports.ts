import { hasMatchingImport, matchesModuleOrSubpath } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_TRPC_PLUGIN_NAME } from "./constants"

/**
 * Module roots that mark a file as a tRPC **client** consumer, matched exactly or as a
 * subpath (`matchesModuleOrSubpath`) because tRPC moves its deep entry points between
 * minors. `@trpc/tanstack-react-query` is deliberately absent: its surface
 * (`queryOptions()` / `mutationOptions()`) is outside this plugin's vocabulary, so opening
 * the gate for it would only widen the false-positive window.
 */
const isTrpcClientModule = matchesModuleOrSubpath("@trpc/client", "@trpc/react-query", "@trpc/next")

/**
 * `@trpc/server` and its adapter subpaths. Purely a discriminator: `publicProcedure
 * .input(schema).query(cb)` normalizes to the same shape as a client `query`, and the
 * import list is the only signal that tells them apart (see `classifyTrpcCall`).
 */
const isTrpcServerModule = matchesModuleOrSubpath("@trpc/server")

/** True when the file imports a tRPC client module; see `hasMatchingImport`. */
export function hasTrpcClientImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_TRPC_PLUGIN_NAME, filePath },
    isTrpcClientModule,
  )
}

/**
 * True when the file imports `@trpc/server` or a subpath. Kept out of the public barrel:
 * it is the classifier's internal discriminator, and a future `@aburi/framework-trpc` needs
 * its own server-side detection scoped to Boundary classification.
 */
export function hasTrpcServerImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_TRPC_PLUGIN_NAME, filePath },
    isTrpcServerModule,
  )
}
