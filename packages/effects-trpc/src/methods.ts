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
