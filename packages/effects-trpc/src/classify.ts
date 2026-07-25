import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { hasTrpcClientImport, hasTrpcServerImport } from "./imports"
import { isTrpcMutationTerminal, isTrpcQueryTerminal, isTrpcSubscriptionTerminal } from "./methods"

/**
 * Shared derivedBy namespace. `manifest.ts` imports this same const for its
 * `derivedByPrefixes` entry, so the classifier's tag builder and the registry declaration
 * cannot drift.
 */
export const EFFECTS_TRPC_DERIVED_BY_PREFIX = "effects-plugin:trpc" as const

/**
 * The one terminal the client and the server share. A client call reads
 * `client.user.byId.query(input)`; a router definition reads
 * `publicProcedure.input(schema).query(resolver)`, which `normalizeCallee` collapses to
 * `publicProcedure.input.query` — the same segment count with the same terminal. The
 * server import gate is the only signal that separates them. See `classifyTrpcCall`.
 */
const SERVER_AMBIGUOUS_TERMINAL = "query"

/**
 * Minimum segment count for a client call. tRPC's proxy is always addressed as
 * `<client>.<procedure path…>.<terminal>`, so even a top-level procedure
 * (`client.getUser.query()`) has three segments. Anything shorter is a proxy accessor
 * (`trpc.useUtils()`) or an unrelated call that happens to share a method name.
 */
const MIN_CLIENT_SEGMENTS = 3

/**
 * Classify a CallCandidate against tRPC client conventions.
 *
 * Every recognized shape maps onto the core `network.rpc` id (ir-schema.md §9.1). That
 * includes subscriptions: tRPC v11 runs them over either `wsLink` (WebSocket) or
 * `httpSubscriptionLink` (SSE), and the transport is not statically decidable from the
 * call site, so committing to `network.ws` would be a guess. The query / mutation /
 * subscription distinction is carried in `derivedBy` instead, alongside the procedure
 * path — `effects-plugin:trpc:query:user.byId`. The path is the router-relative address,
 * which `Effect.target` does not give on its own: `target` still carries the local client
 * binding and the terminal.
 *
 * Three design decisions this function encodes:
 *
 * **1. Import gate is the primary false-positive defense.** Terminals like `query` /
 *    `subscribe` are far too common to match on shape alone. Only files importing
 *    `@trpc/client` / `@trpc/react-query` / `@trpc/next` (or a subpath) are considered.
 *    The known cost is a false negative on the common `src/utils/trpc.ts` wrapper layout,
 *    where consuming components import the wrapper rather than tRPC itself — resolving
 *    that needs cross-file binding resolution, i.e. the LSP enrichment tier.
 *
 * **2. Server-side shapes are never effects.** A router definition is a Boundary, and
 *    `type: "effects"` plugins may not declare extKinds (extension-vocab.md §6.1), so
 *    that classification belongs to a future framework plugin. Concretely, this function
 *    refuses the `query` terminal in any file that imports `@trpc/server`: in such a file
 *    a `query`-terminated target cannot be told apart from a procedure builder. The
 *    suppression is scoped to `query` alone because the server spells its other verbs
 *    `mutation` / `subscription`, which are absent from the client vocabulary.
 *
 * **3. One effect per call site.** tRPC is not a fluent builder, so no chain collapsing
 *    is needed — but `await client.user.byId.query().then(cb)` does emit a second
 *    candidate whose terminal is `then`. It falls out of the vocabulary naturally.
 *
 * Throws when the language plugin emits a malformed target (empty string, adjacent dots)
 * or a malformed import edge. Callers should treat a thrown error as an upstream contract
 * violation, not a classification decision.
 *
 * Pure with respect to plugin state — matches the per-call timeout budget the core
 * enforces (effect-plugin.md §5.1.1).
 */
export function classifyTrpcCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  // Fail-fast runs BEFORE the import gate so a malformed target throws on every file, not
  // just the small share that import tRPC. Ordering the other way lets the same bug
  // surface only in tRPC-consuming files and stay silent everywhere else — catastrophic
  // for reproducing upstream language-plugin bugs.
  const parts = assertNonEmptySegments(call.target, ctx.file.path)

  if (!hasTrpcClientImport(ctx.file.imports, ctx.file.path)) return null

  // `this.trpc.user.byId.query()` inside a class method carries the receiver keyword as a
  // leading segment. Dropping it makes the procedure path identical to what the same call
  // produces through a module-level binding, so `derivedBy` stays comparable across both.
  const segments = parts[0] === "this" ? parts.slice(1) : parts
  if (segments.length < MIN_CLIENT_SEGMENTS) return null

  const terminal = segments[segments.length - 1]
  if (terminal === undefined) return null

  if (
    terminal === SERVER_AMBIGUOUS_TERMINAL &&
    hasTrpcServerImport(ctx.file.imports, ctx.file.path)
  )
    return null

  const family = terminalFamily(terminal)
  if (family === null) return null

  // Everything between the client binding and the terminal is the router-relative path.
  // Guaranteed non-empty by the MIN_CLIENT_SEGMENTS check above.
  const procedurePath = segments.slice(1, -1).join(".")

  return {
    effectId: "network.rpc",
    confidence: "high",
    derivedBy: `${EFFECTS_TRPC_DERIVED_BY_PREFIX}:${family}:${procedurePath}`,
  }
}

/**
 * The derivedBy family suffix for a terminal, or `null` when the terminal is outside the
 * plugin's vocabulary. The three families are pairwise disjoint, so the dispatch order
 * here carries no meaning.
 */
function terminalFamily(terminal: string): "query" | "mutation" | "subscription" | null {
  if (isTrpcQueryTerminal(terminal)) return "query"
  if (isTrpcMutationTerminal(terminal)) return "mutation"
  if (isTrpcSubscriptionTerminal(terminal)) return "subscription"
  return null
}

/**
 * Split `target` on `.` and reject any shape a well-formed language plugin would never
 * emit: an empty target, or one with an empty segment (leading, trailing, or adjacent
 * dots). A malformed target would otherwise slip through the length gate and
 * false-classify — `"client..user.query"` has four segments and would match the query
 * terminal. `filePath` is threaded into the error message so caught exceptions in
 * production point at the offending source file.
 */
function assertNonEmptySegments(target: string, filePath: string): readonly string[] {
  if (target.length === 0) {
    throw new Error(
      `effects-trpc (${filePath}): CallCandidate.target is empty — language plugin emitted an unnormalized callee`,
    )
  }
  const parts = target.split(".")
  for (const segment of parts) {
    if (segment.length === 0) {
      throw new Error(
        `effects-trpc (${filePath}): CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`,
      )
    }
  }
  return parts
}
