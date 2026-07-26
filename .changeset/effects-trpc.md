---
"@aburi/effects-trpc": minor
---

Add `@aburi/effects-trpc`, a new effect plugin that classifies tRPC client
procedure calls into the core `network.rpc` effect vocabulary.

### Recognised shapes

Two-signal join before returning an effect:

1. The file's import list must contain `@trpc/client`, `@trpc/react-query`, or
   `@trpc/next` — exact match or any subpath (`@trpc/client/links/httpBatchLink`,
   `@trpc/next/app-dir/client`, ...). The gate is a **prefix match** rather than a
   closed allowlist because tRPC moves its deep entry points between minors; the
   `/` separator keeps lookalikes (`@trpc/client-mock`,
   `@trpc/react-query-devtools`) out. No import → `null` and control flows to the
   next effect plugin.
2. `CallCandidate.target` must be at least three segments — tRPC's proxy is
   always addressed as `<client>.<procedure path…>.<terminal>`, so even a
   top-level procedure (`client.getUser.query()`) has three — and its terminal
   must be in the client vocabulary:
   - `query` / `useQuery` / `useInfiniteQuery` / `useSuspenseQuery` /
     `useSuspenseInfiniteQuery` / `usePrefetchQuery` / `usePrefetchInfiniteQuery`
   - `mutate` / `useMutation`
   - `subscribe` / `useSubscription`

A leading `this` receiver is stripped before the segment count and the path are
computed, so `this.trpc.user.byId.query()` inside a class method yields the same
procedure path as the same call through a module-level binding.

### One effect id, three families

Every recognised shape returns core `network.rpc`. Subscriptions included: tRPC
v11 runs them over either `wsLink` (WebSocket) or `httpSubscriptionLink` (SSE),
and the transport is not statically decidable from the call site, so committing
to `network.ws` would be a guess. The distinction rides in `derivedBy` instead,
together with the router-relative procedure path:
`effects-plugin:trpc:query:user.byId` /
`effects-plugin:trpc:mutation:user.create` /
`effects-plugin:trpc:subscription:onAdd`. The path is information
`Effect.target` does not carry on its own — `target` still holds the local client
binding and the terminal.

### Server-side routers are not effects

`t.router({...})` and `publicProcedure.input(...).query(resolver)` are never
classified. A router definition is a Boundary, and per extension-vocab.md §6.1 a
`type: "effects"` plugin may not declare the `framework:trpc:*` extKinds that
Boundary classification would need — that is a companion framework plugin's job.

The two sides collide concretely: the language plugin normalizes
`publicProcedure.input(schema).query(resolver)` to `publicProcedure.input.query`,
structurally identical to a client call. Since the import list is the only
discriminator, **the `query` terminal is not classified in any file that imports
`@trpc/server`**. The suppression is scoped to `query` alone — the server spells
its other verbs `mutation` / `subscription`, absent from the client vocabulary —
so `mutate` / `subscribe` / the hooks keep classifying in a file that colocates a
router and a client.

### Deliberately unclassified

- `useUtils()` / `useContext()` and the cache helpers reached through them
  (`invalidate` / `fetch` / `prefetch` / `ensureData`): the receiver is a local
  binding with nothing tying it back to tRPC, and `fetch` is far too generic to
  claim.
- `queryOptions()` / `infiniteQueryOptions()` / `mutationOptions()` /
  `subscriptionOptions()` from `@trpc/tanstack-react-query`: they build an options
  object, and the request happens in the `useQuery` that consumes it.
- `createCaller` invocations (`caller.user.byId()`): invoked by the procedure's
  own name, so there is no terminal to match.

### Known limitations

- Components that import a local wrapper (`import { trpc } from "~/utils/trpc"`)
  instead of `@trpc/*` do not pass the import gate. Resolving that needs
  cross-file binding resolution — the LSP enrichment tier.
- `subscribe` shares its name with RxJS and EventEmitter APIs. The three-segment
  minimum plus the client import gate filter almost all of it; a file colocating
  RxJS with a tRPC vanilla client is the residual risk.
- Only the first segment is treated as the client binding, so a client behind a
  longer receiver chain (`api.trpc.user.byId.query()`, or a `this` aliased to
  `self`) records an over-qualified path — `trpc.user.byId` rather than
  `user.byId`. The effect id and `target` stay correct; nothing in the target
  string marks where the binding ends and the router path begins.

### Manifest

`type: "effects"` with `xPrefix` deriving to `"trpc"` from the package name.
`provides.effects` and `provides.effectPrefixes` are empty — every
classification returns core-owned `network.rpc`, which extension-vocab.md §5.1
forbids a plugin from declaring. `extKinds` / `extKindPrefixes` / `frameworks`
are empty and must stay so for a `type: "effects"` manifest.
`derivedByPrefixes: ["effects-plugin:trpc"]` owns the plugin-scoped rationale so
consumers can trace every effect back here.

### Public API

`trpcEffectsPlugin` (ready-to-register instance), `TrpcEffectsPlugin` (class),
`classifyTrpcCall`, `hasTrpcClientImport`, `effectsTrpcManifest`, the
terminal-vocabulary constants (`TRPC_QUERY_TERMINALS`,
`TRPC_MUTATION_TERMINALS`, `TRPC_SUBSCRIPTION_TERMINALS`) with corresponding
type guards, plus types `TrpcQueryTerminal`, `TrpcMutationTerminal`,
`TrpcSubscriptionTerminal`.

The server-import check that drives the `query` suppression is intentionally not
exported — it is the classifier's internal discriminator, and a future
`@aburi/framework-trpc` needs server-side detection scoped to what Boundary
classification requires rather than to this suppression rule.

### Purity

`classify()` is a pure lookup — no I/O, no state, no async — matching the
per-call timeout budget the core enforces (effect-plugin.md §5.1.1). Repeated
invocations against the same CallCandidate produce identical results, and the
plugin holds no state across calls. It throws only on upstream contract
violations: a malformed `CallCandidate.target` (empty string, adjacent dots) or a
malformed `ImportEdge.source`, both with the offending file path in the message.
