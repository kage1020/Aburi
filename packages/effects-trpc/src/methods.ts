/**
 * tRPC client terminal vocabulary, grouped by the kind of procedure the call invokes.
 *
 * Each `_LIST` is the single source of truth — the union type and the runtime `Set` are
 * both derived from it, so extending the vocabulary as tRPC ships new hooks is a table
 * edit in exactly one place.
 *
 * Everything here is a **client** terminal. The server-side procedure builder spells its
 * counterparts `mutation` / `subscription` / `router` / `procedure`, and those are
 * deliberately absent: a router definition is a Boundary concern for a framework plugin,
 * not a call that reaches the network. (`query` is the one terminal the two sides share;
 * `classifyTrpcCall` resolves that collision through the import gate.)
 *
 * Deliberate omissions, each because the shape cannot be attributed to tRPC from the
 * target string alone or does not perform a call:
 *
 * - `useUtils` / `useContext` — obtain a cache proxy; also always two segments.
 * - `invalidate` / `fetch` / `prefetch` / `ensureData` — the useUtils cache surface. The
 *   receiver is a local binding (`utils`) with nothing tying it back to tRPC, and `fetch`
 *   is far too generic a name to claim.
 * - `mutateAsync` — a method on TanStack's mutation object, always two segments.
 * - `queryOptions` / `infiniteQueryOptions` / `mutationOptions` / `subscriptionOptions`
 *   (`@trpc/tanstack-react-query`) — build an options object; the request happens in the
 *   `useQuery` that consumes it.
 * - `createCaller` procedures (`caller.user.byId()`) — invoked by their own name, so there
 *   is no terminal to match.
 */
const TRPC_QUERY_TERMINALS_LIST = [
  "query",
  "useQuery",
  "useInfiniteQuery",
  "useSuspenseQuery",
  "useSuspenseInfiniteQuery",
  "usePrefetchQuery",
  "usePrefetchInfiniteQuery",
] as const

const TRPC_MUTATION_TERMINALS_LIST = ["mutate", "useMutation"] as const

/**
 * Subscription terminals. `subscribe` is the vanilla-client form and `useSubscription`
 * the React Query hook. Note that `subscribe` collides by name with RxJS observables and
 * EventEmitter-style APIs — the client import gate plus the three-segment minimum in
 * `classifyTrpcCall` are what keep that from false-classifying.
 */
const TRPC_SUBSCRIPTION_TERMINALS_LIST = ["subscribe", "useSubscription"] as const

export type TrpcQueryTerminal = (typeof TRPC_QUERY_TERMINALS_LIST)[number]
export type TrpcMutationTerminal = (typeof TRPC_MUTATION_TERMINALS_LIST)[number]
export type TrpcSubscriptionTerminal = (typeof TRPC_SUBSCRIPTION_TERMINALS_LIST)[number]

export const TRPC_QUERY_TERMINALS: ReadonlySet<TrpcQueryTerminal> = new Set(
  TRPC_QUERY_TERMINALS_LIST,
)
export const TRPC_MUTATION_TERMINALS: ReadonlySet<TrpcMutationTerminal> = new Set(
  TRPC_MUTATION_TERMINALS_LIST,
)
export const TRPC_SUBSCRIPTION_TERMINALS: ReadonlySet<TrpcSubscriptionTerminal> = new Set(
  TRPC_SUBSCRIPTION_TERMINALS_LIST,
)

export function isTrpcQueryTerminal(name: string): name is TrpcQueryTerminal {
  return (TRPC_QUERY_TERMINALS as ReadonlySet<string>).has(name)
}

export function isTrpcMutationTerminal(name: string): name is TrpcMutationTerminal {
  return (TRPC_MUTATION_TERMINALS as ReadonlySet<string>).has(name)
}

export function isTrpcSubscriptionTerminal(name: string): name is TrpcSubscriptionTerminal {
  return (TRPC_SUBSCRIPTION_TERMINALS as ReadonlySet<string>).has(name)
}
