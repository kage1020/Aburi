import { describe, expect, it } from "vitest"
import {
  isTrpcMutationTerminal,
  isTrpcQueryTerminal,
  isTrpcSubscriptionTerminal,
  TRPC_MUTATION_TERMINALS,
  TRPC_QUERY_TERMINALS,
  TRPC_SUBSCRIPTION_TERMINALS,
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

  it("keeps the three families pairwise disjoint", () => {
    // A terminal appearing in two families would make the classifier's dispatch order
    // load-bearing; the derivedBy suffix it emits would silently depend on branch order.
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
    // Server-side procedure builders are a Boundary concern, not an effect. Including
    // any of these would turn a router definition into a `network.rpc` call site.
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
