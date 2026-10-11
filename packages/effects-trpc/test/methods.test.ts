import { describe, expect, it } from "vitest"
import {
  isTrpcMutationTerminal,
  isTrpcQueryTerminal,
  isTrpcSubscriptionTerminal,
  TRPC_MUTATION_TERMINALS,
  TRPC_QUERY_TERMINALS,
  TRPC_SUBSCRIPTION_TERMINALS,
} from "../src/index"

describe("tRPC terminal vocabulary", () => {
  it.each([
    [
      "query",
      TRPC_QUERY_TERMINALS,
      isTrpcQueryTerminal,
      [
        "query",
        "useQuery",
        "useInfiniteQuery",
        "useSuspenseQuery",
        "useSuspenseInfiniteQuery",
        "usePrefetchQuery",
        "usePrefetchInfiniteQuery",
      ],
    ],
    ["mutation", TRPC_MUTATION_TERMINALS, isTrpcMutationTerminal, ["mutate", "useMutation"]],
    [
      "subscription",
      TRPC_SUBSCRIPTION_TERMINALS,
      isTrpcSubscriptionTerminal,
      ["subscribe", "useSubscription"],
    ],
  ] as const)("lists exactly the %s terminals, and its guard accepts each", (_family, set, guard, members) => {
    expect([...set]).toEqual(members)
    for (const terminal of members) expect(guard(terminal)).toBe(true)
  })
})
