import { assertNonEmptySegments, type PluginInputOrigin } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX, EFFECTS_TRPC_PLUGIN_NAME } from "./constants"
import { hasTrpcClientImport, hasTrpcServerImport } from "./imports"
import {
  isTrpcMutationTerminal,
  isTrpcQueryTerminal,
  isTrpcSubscriptionTerminal,
  type TrpcQueryTerminal,
} from "./methods"

/**
 * The one terminal the client and the server share: `client.user.byId.query(input)` and
 * the router's `publicProcedure.input(schema).query(resolver)` normalize to the same
 * segment count with the same terminal, and the server import gate is the only signal that
 * separates them (decision 2 on `classifyTrpcCall`). Typed as `TrpcQueryTerminal` so a
 * renamed terminal breaks the build instead of leaving a suppression that matches nothing.
 */
const SERVER_AMBIGUOUS_TERMINAL: TrpcQueryTerminal = "query"

/**
 * tRPC's proxy is always `<client>.<procedure path…>.<terminal>`, so even a top-level
 * procedure has three segments. Anything shorter is a proxy accessor (`trpc.useUtils()`) or
 * an unrelated call sharing a method name.
 */
const MIN_CLIENT_SEGMENTS = 3

/**
 * Classify a CallCandidate against tRPC client conventions.
 *
 * Every recognized shape maps onto the core `network.rpc` id (ir-schema.md),
 * subscriptions included: tRPC v11 runs them over `wsLink` or `httpSubscriptionLink`, and
 * the transport is not decidable from the call site, so `network.ws` would be a guess. The
 * query / mutation / subscription family and the router-relative procedure path go into
 * `derivedBy` instead (`effects-plugin:trpc:query:user.byId`), since `target` only carries
 * the local client binding and the terminal.
 *
 * 1. **The import gate is the primary false-positive defense.** `query` / `subscribe` are
 *    far too common to match on shape alone, so only files importing a client module
 *    count. The known cost is a false negative on the `src/utils/trpc.ts` wrapper layout,
 *    where consumers import the wrapper — resolving that needs the LSP enrichment tier.
 * 2. **Server-side shapes are never effects.** A router definition is a Boundary, and
 *    `type: "effects"` plugins may not declare extKinds (extension-vocab.md), so the
 *    `query` terminal is refused in any file that imports `@trpc/server`. Only `query`: the
 *    server spells its other verbs `mutation` / `subscription`, absent from the client
 *    vocabulary.
 * 3. **A receiver that is not a name costs the tier.** `handlers[key].query()` reaches the
 *    segment count carrying `<computed>` where a procedure name belongs;
 *    `CallCandidate.dynamicReceiver` marks it and the call is recorded at `medium`.
 * 4. **One effect per call site.** tRPC is not a fluent builder, and the `then` candidate
 *    of `await client.user.byId.query().then(cb)` falls out of the vocabulary naturally.
 *
 * Throws on a malformed target or import edge: upstream contract violations, not
 * classification decisions. Pure with respect to plugin state (effect-plugin.md).
 */
export function classifyTrpcCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_TRPC_PLUGIN_NAME, filePath: ctx.file.path }

  // Fail-fast runs BEFORE the import gate — see `assertNonEmptySegments` for why.
  // `terminal` is the validated last segment; the `this` strip below never removes it.
  const { segments, last: terminal } = assertNonEmptySegments(call.target, origin)

  if (!hasTrpcClientImport(ctx.file.imports, ctx.file.path)) return null

  // `this.trpc.user.byId.query()` inside a class method carries the receiver keyword as a
  // leading segment; dropping it keeps `derivedBy` comparable with the module-level form.
  const clientPath = segments[0] === "this" ? segments.slice(1) : segments
  if (clientPath.length < MIN_CLIENT_SEGMENTS) return null

  if (
    terminal === SERVER_AMBIGUOUS_TERMINAL &&
    hasTrpcServerImport(ctx.file.imports, ctx.file.path)
  )
    return null

  const family = terminalFamily(terminal)
  if (family === null) return null

  // Everything between the client binding and the terminal is the router-relative path —
  // non-empty, since MIN_CLIENT_SEGMENTS leaves at least one segment after `slice(1, -1)`.
  // This assumes the binding is one segment: a client behind a longer receiver chain
  // (`api.trpc.user.byId.query()`) shifts the extra segments into the recorded path.
  // Nothing in the target marks where the binding ends, so a syntactic classifier cannot
  // do better — see README "Known limitations".
  const procedurePath = clientPath.slice(1, -1).join(".")

  return {
    effectId: "network.rpc",
    // The dynamic-receiver arm of `receiverConfidence`; tRPC has no client vocabulary or
    // arity rule, so the other arms do not apply.
    confidence: call.dynamicReceiver === true ? "medium" : "high",
    derivedBy: `${EFFECTS_TRPC_DERIVED_BY_PREFIX}:${family}:${procedurePath}`,
  }
}

/**
 * The derivedBy family suffix for a terminal, or `null` outside the vocabulary. The three
 * families are pairwise disjoint, so the dispatch order carries no meaning.
 */
function terminalFamily(terminal: string): "query" | "mutation" | "subscription" | null {
  if (isTrpcQueryTerminal(terminal)) return "query"
  if (isTrpcMutationTerminal(terminal)) return "mutation"
  if (isTrpcSubscriptionTerminal(terminal)) return "subscription"
  return null
}
