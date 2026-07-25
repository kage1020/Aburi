# @aburi/effects-trpc

tRPC effect plugin for `@aburi/core`. Classifies tRPC **client** procedure calls
into the core `network.rpc` effect so the IR can show that a method reaches a
remote procedure rather than leaving the call as an opaque string in
`Symbol.calls[]`.

Recognised shapes:

| Source shape | Effect | `derivedBy` |
|---|---|---|
| `<client>.<path…>.query(...)` (vanilla client) | `network.rpc` | `effects-plugin:trpc:query:<path>` |
| `<client>.<path…>.useQuery / useInfiniteQuery / useSuspenseQuery / useSuspenseInfiniteQuery / usePrefetchQuery / usePrefetchInfiniteQuery(...)` | `network.rpc` | `effects-plugin:trpc:query:<path>` |
| `<client>.<path…>.mutate(...)` / `.useMutation(...)` | `network.rpc` | `effects-plugin:trpc:mutation:<path>` |
| `<client>.<path…>.subscribe(...)` / `.useSubscription(...)` | `network.rpc` | `effects-plugin:trpc:subscription:<path>` |

`<path>` is the router-relative procedure path — `client.user.byId.query()`
records `user.byId`. A leading `this` receiver is stripped first, so
`this.trpc.user.byId.query()` inside a class method produces the same path as the
same procedure called through a module-level binding.

### Why every family maps to `network.rpc`

tRPC v11 runs subscriptions over either `wsLink` (WebSocket) or
`httpSubscriptionLink` (SSE), and the transport is not decidable from the call
site — committing to `network.ws` would be a guess. `network.rpc` is
transport-agnostic and correct for all three families; the query / mutation /
subscription distinction rides in `derivedBy` instead. Consumers that need it
read the suffix, and `Effect.target` still carries the verbatim callee.

### Layered gate

A file that imports `@trpc/client`, `@trpc/react-query`, or `@trpc/next` (or any
subpath such as `@trpc/client/links/httpBatchLink`) is a prerequisite, and the
target must have at least three segments — tRPC's proxy is always addressed as
`<client>.<procedure path…>.<terminal>`, so even a top-level procedure
(`client.getUser.query()`) has three. The import gate is what keeps generic
terminals like `query` and `subscribe` from matching unrelated code, and the
prefix match keeps lookalikes (`@trpc/client-mock`, `@trpc/react-query-devtools`)
out.

### Server-side routers are out of scope

`t.router({...})` and `publicProcedure.input(...).query(resolver)` are **not**
classified. A router definition is a Boundary, not a call that reaches the
network, and per [`extension-vocab.md`](../../docs/design/extension-vocab.md) §6.1
a `type: "effects"` plugin may not declare the `framework:trpc:*` extKinds that
Boundary classification would need. That belongs to a companion framework plugin.

This matters concretely because the two sides collide: the language plugin
normalizes `publicProcedure.input(schema).query(resolver)` to
`publicProcedure.input.query`, which is structurally identical to a client call.
The only available discriminator is the import list, so **the `query` terminal is
never classified in a file that imports `@trpc/server`**. The suppression is
scoped to `query` alone — the server spells its other verbs `mutation` /
`subscription`, which are absent from the client vocabulary, so `mutate` /
`subscribe` / the hooks keep classifying even in a file that colocates both.

### Known limitations

- **Local client wrappers.** The common layout wraps `createTRPCReact` in
  `src/utils/trpc.ts` and has components `import { trpc } from "~/utils/trpc"`.
  Those component files carry no `@trpc/*` import, so they do not pass the gate
  and their calls go unclassified. Resolving this needs cross-file binding
  resolution — the [LSP enrichment](../../docs/design/lsp-enrichment.md) tier.
- **`subscribe` shares its name** with RxJS observables and EventEmitter-style
  APIs. The three-segment minimum and the client import gate filter almost all of
  it; a file that colocates RxJS with a tRPC vanilla client is the residual risk.

### Deliberately unclassified surfaces

- `trpc.useUtils()` / `useContext()` and the cache helpers reached through them
  (`utils.post.all.invalidate()` / `.fetch()` / `.prefetch()` / `.ensureData()`) —
  the receiver is a local binding with nothing tying it back to tRPC, and `fetch`
  is far too generic a name to claim.
- `queryOptions()` / `infiniteQueryOptions()` / `mutationOptions()` /
  `subscriptionOptions()` from `@trpc/tanstack-react-query` — these build an
  options object; the request happens in the `useQuery` that consumes it.
  Classifying here would attach an effect to code that never reaches the network.
- `createCaller` server-side invocations (`caller.user.byId()`) — invoked by the
  procedure's own name, so there is no terminal to match.

## Install

```bash
pnpm add @aburi/effects-trpc
```

## Usage

```ts
import { trpcEffectsPlugin } from "@aburi/effects-trpc"
```

## See also

- [`docs/design/effect-plugin.md`](../../docs/design/effect-plugin.md)
