import { describe, expect, expectTypeOf, it } from "vitest"
import {
  isTrpcMutationTerminal,
  isTrpcQueryTerminal,
  isTrpcSubscriptionTerminal,
  TRPC_MUTATION_TERMINALS,
  TRPC_QUERY_TERMINALS,
  TRPC_SUBSCRIPTION_TERMINALS,
  type TrpcMutationTerminal,
  type TrpcQueryTerminal,
  type TrpcSubscriptionTerminal,
} from "../src/index"

const ALL_SETS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ["query", TRPC_QUERY_TERMINALS],
  ["mutation", TRPC_MUTATION_TERMINALS],
  ["subscription", TRPC_SUBSCRIPTION_TERMINALS],
]

describe("tRPC terminal vocabulary", () => {
  it("exposes the vanilla-client terminals on the matching families", () => {
    expect(isTrpcQueryTerminal("query")).toBe(true)
    expect(isTrpcMutationTerminal("mutate")).toBe(true)
    expect(isTrpcSubscriptionTerminal("subscribe")).toBe(true)
  })

  it.each([
    "useQuery",
    "useInfiniteQuery",
    "useSuspenseQuery",
    "useSuspenseInfiniteQuery",
    "usePrefetchQuery",
    "usePrefetchInfiniteQuery",
  ])("recognizes the React Query read hook %s as a query terminal", (terminal) => {
    expect((TRPC_QUERY_TERMINALS as ReadonlySet<string>).has(terminal)).toBe(true)
    expect(isTrpcQueryTerminal(terminal)).toBe(true)
  })

  it("recognizes useMutation and useSubscription on their families", () => {
    expect(isTrpcMutationTerminal("useMutation")).toBe(true)
    expect(isTrpcSubscriptionTerminal("useSubscription")).toBe(true)
  })

  it("keeps the three families pairwise disjoint at the type level", () => {
    expectTypeOf<Extract<TrpcQueryTerminal, TrpcMutationTerminal>>().toBeNever()
    expectTypeOf<Extract<TrpcQueryTerminal, TrpcSubscriptionTerminal>>().toBeNever()
    expectTypeOf<Extract<TrpcMutationTerminal, TrpcSubscriptionTerminal>>().toBeNever()
  })

  it("keeps the three families pairwise disjoint", () => {
    for (const [nameA, setA] of ALL_SETS) {
      for (const [nameB, setB] of ALL_SETS) {
        if (nameA === nameB) continue
        for (const terminal of setA) expect(setB.has(terminal)).toBe(false)
      }
    }
  })

  it("agrees between each set and its type guard", () => {
    const guards = {
      query: isTrpcQueryTerminal,
      mutation: isTrpcMutationTerminal,
      subscription: isTrpcSubscriptionTerminal,
    } as const
    for (const [family, set] of ALL_SETS) {
      const guard = guards[family as keyof typeof guards]
      for (const terminal of set) expect(guard(terminal)).toBe(true)
    }
  })

  it.each([
    "mutation",
    "subscription",
    "router",
    "procedure",
    "middleware",
    "input",
    "output",
  ])("excludes the server-side router vocabulary term %s from every family", (terminal) => {
    for (const [, set] of ALL_SETS) expect(set.has(terminal)).toBe(false)
  })

  it.each([
    "useUtils",
    "useContext",
    "invalidate",
    "prefetch",
    "ensureData",
    "mutateAsync",
    "queryOptions",
    "infiniteQueryOptions",
    "mutationOptions",
    "subscriptionOptions",
    "createCaller",
    "then",
  ])("excludes the deliberately unsupported surface %s", (terminal) => {
    for (const [, set] of ALL_SETS) expect(set.has(terminal)).toBe(false)
  })
})
