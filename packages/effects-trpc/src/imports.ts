import { hasMatchingImport } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_TRPC_PLUGIN_NAME } from "./constants"

/**
 * Module roots that mark a file as a tRPC **client** consumer. Each entry matches either
 * exactly or as a `<root>/` subpath prefix — tRPC ships deep entry points
 * (`@trpc/client/links/httpBatchLink`, `@trpc/next/app-dir/client`, ...) and moves them
 * between minors, so a closed allowlist of full specifiers would silently stop matching.
 * The trailing slash in the subpath form is what keeps third-party lookalikes such as
 * `@trpc/client-mock` or `@trpc/react-query-devtools` from passing the gate.
 *
 * `@trpc/tanstack-react-query` is deliberately absent: the surface it contributes
 * (`queryOptions()` / `mutationOptions()` / `subscriptionOptions()`) is outside this
 * plugin's vocabulary, so letting it open the gate would only widen the false-positive
 * window without enabling a single classification.
 */
const TRPC_CLIENT_MODULE_ROOTS = ["@trpc/client", "@trpc/react-query", "@trpc/next"] as const

/**
 * Module roots that mark a file as a tRPC **server** (router-defining) module. Matched
 * with the same exact-or-subpath rule so adapter entry points
 * (`@trpc/server/adapters/next`, `@trpc/server/adapters/fetch`, ...) are covered.
 *
 * This gate exists purely as a discriminator: `publicProcedure.input(schema).query(cb)`
 * normalizes to the same shape as a client `client.user.byId.query`, and the import list
 * is the only signal available to tell them apart. See design decision #2 on
 * `classifyTrpcCall` for how the resulting suppression is scoped.
 */
const TRPC_SERVER_MODULE_ROOTS = ["@trpc/server"] as const

/** Exact-or-subpath match against a set of module roots. */
function matchesAnyRoot(source: string, roots: readonly string[]): boolean {
  return roots.some((root) => source === root || source.startsWith(`${root}/`))
}

/**
 * True when the file's import list contains any tRPC client module. See
 * `TRPC_CLIENT_MODULE_ROOTS` for what counts.
 *
 * An empty source string on an ImportEdge is rejected by the shared guard: the language
 * plugin's contract is to emit normalized non-empty specifiers, and treating `""` as
 * unmatched would silently hide upstream bugs.
 *
 * `filePath` is required and threaded into any thrown error message so a caught exception
 * in production tooling (CI logs, error reporters) points directly at the offending source
 * file rather than a bare "empty source" string.
 */
export function hasTrpcClientImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(imports, { plugin: EFFECTS_TRPC_PLUGIN_NAME, filePath }, (source) =>
    matchesAnyRoot(source, TRPC_CLIENT_MODULE_ROOTS),
  )
}

/**
 * True when the file's import list contains `@trpc/server` or any of its subpaths. Same
 * validation and error-reporting contract as `hasTrpcClientImport`.
 *
 * Deliberately kept out of the public barrel: this is the classifier's internal
 * discriminator, not a capability the plugin offers its consumers. A future
 * `@aburi/framework-trpc` needs its own server-side detection anyway, scoped to what
 * Boundary classification requires rather than to this suppression rule.
 */
export function hasTrpcServerImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(imports, { plugin: EFFECTS_TRPC_PLUGIN_NAME, filePath }, (source) =>
    matchesAnyRoot(source, TRPC_SERVER_MODULE_ROOTS),
  )
}
