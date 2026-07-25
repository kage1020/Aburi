import type { ImportEdge } from "@aburi/types"

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

/**
 * True when the file's import list contains any tRPC client module. See
 * `TRPC_CLIENT_MODULE_ROOTS` for what counts.
 *
 * An empty source string on an ImportEdge is rejected: the language plugin's contract is
 * to emit normalized non-empty specifiers, and treating `""` as unmatched would silently
 * hide upstream bugs. Validation runs across every edge before the match check so
 * ImportEdge order does not make throw behavior non-deterministic — `.some()` alone would
 * short-circuit on the first match and never notice a broken edge sitting later.
 *
 * `filePath` is required and threaded into any thrown error message so a caught exception
 * in production tooling (CI logs, error reporters) points directly at the offending source
 * file rather than a bare "empty source" string.
 */
export function hasTrpcClientImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return matchesAnyRoot(imports, filePath, TRPC_CLIENT_MODULE_ROOTS)
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
  return matchesAnyRoot(imports, filePath, TRPC_SERVER_MODULE_ROOTS)
}

function matchesAnyRoot(
  imports: readonly ImportEdge[],
  filePath: string,
  roots: readonly string[],
): boolean {
  for (const edge of imports) {
    if (edge.source.length === 0) {
      throw new Error(
        `effects-trpc (${filePath}, line ${edge.line}): ImportEdge.source is empty — language plugin emitted an unnormalized import edge`,
      )
    }
  }
  return imports.some((edge) =>
    roots.some((root) => edge.source === root || edge.source.startsWith(`${root}/`)),
  )
}
