import { makeCall, makeCtx } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyTrpcCall } from "../src/index"
import { makeTrpcClientImport, makeTrpcServerImport } from "./fixtures/context"

const clientCtx = makeCtx({ imports: [makeTrpcClientImport()] })
const bothCtx = makeCtx({ imports: [makeTrpcClientImport(), makeTrpcServerImport()] })

describe("classifyTrpcCall — client procedure calls", () => {
  it.each([
    ["client.user.byId.query", "query:user.byId"],
    ["client.getUser.query", "query:getUser"],
    ["client.admin.billing.invoice.byId.query", "query:admin.billing.invoice.byId"],
    ["this.trpc.user.byId.query", "query:user.byId"],
    ["trpc.post.list.useQuery", "query:post.list"],
    ["trpc.post.list.useInfiniteQuery", "query:post.list"],
    ["trpc.post.list.useSuspenseQuery", "query:post.list"],
    ["trpc.post.list.useSuspenseInfiniteQuery", "query:post.list"],
    ["trpc.post.list.usePrefetchQuery", "query:post.list"],
    ["trpc.post.list.usePrefetchInfiniteQuery", "query:post.list"],
    ["client.user.create.mutate", "mutation:user.create"],
    ["trpc.user.create.useMutation", "mutation:user.create"],
    ["client.onAdd.subscribe", "subscription:onAdd"],
    ["trpc.onAdd.useSubscription", "subscription:onAdd"],
  ])("classifies %s as network.rpc, tagged %s", (target, tag) => {
    expect(classifyTrpcCall(makeCall({ target }), clientCtx)).toEqual({
      effectId: "network.rpc",
      confidence: "high",
      derivedBy: `effects-plugin:trpc:${tag}`,
    })
  })

  it("over-qualifies the path when the client sits behind a multi-segment receiver", () => {
    expect(
      classifyTrpcCall(makeCall({ target: "api.trpc.user.byId.query" }), clientCtx)?.derivedBy,
    ).toBe("effects-plugin:trpc:query:trpc.user.byId")
  })

  it.each([
    ["handlers.<computed>.query", "query:<computed>"],
    ["getClient.user.byId.query", "query:user.byId"],
  ])("records %s, reached through an expression, at medium", (target, tag) => {
    expect(classifyTrpcCall(makeCall({ target, dynamicReceiver: true }), clientCtx)).toEqual({
      effectId: "network.rpc",
      confidence: "medium",
      derivedBy: `effects-plugin:trpc:${tag}`,
    })
  })
})

describe("classifyTrpcCall — a file that imports @trpc/server too", () => {
  it.each([
    "client.user.byId.query",
    "publicProcedure.input.query",
    "t.procedure.query",
  ])("returns null for %s — `query` is the router's own builder verb there", (target) => {
    expect(classifyTrpcCall(makeCall({ target }), bothCtx)).toBeNull()
  })

  it.each([
    "client.user.create.mutate",
    "client.onAdd.subscribe",
    "trpc.post.list.useQuery",
  ])("still classifies %s, which the router does not spell", (target) => {
    expect(classifyTrpcCall(makeCall({ target }), bothCtx)?.effectId).toBe("network.rpc")
  })
})

describe("classifyTrpcCall — calls that are not a procedure call", () => {
  it.each([
    ["no import at all", []],
    ["only @trpc/server", [makeTrpcServerImport()]],
    [
      "unrelated libraries",
      [
        { source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false },
        { source: "rxjs", symbols: ["Observable"], line: 2, dynamic: false },
      ],
    ],
  ])("returns null in a file that imports %s instead of a tRPC client", (_label, imports) => {
    const ctx = makeCtx({ imports })
    for (const target of [
      "client.user.byId.query",
      "client.user.create.mutate",
      "client.onAdd.subscribe",
      "trpc.post.list.useQuery",
    ]) {
      expect(classifyTrpcCall(makeCall({ target }), ctx)).toBeNull()
    }
  })

  it.each([
    ["trpc.useUtils", "two segments"],
    ["client.query", "two segments"],
    ["query.foo", "two segments"],
    ["subscribe.now", "two segments"],
    ["query", "one segment"],
    ["this.client.query", "two segments once `this` is stripped"],
    ["this", "nothing once `this` is stripped"],
    ["utils.user.byId.invalidate", "the useUtils cache surface"],
    ["utils.user.byId.fetch", "the useUtils cache surface"],
    ["utils.post.all.ensureData", "the useUtils cache surface"],
    ["trpc.post.list.queryOptions", "the @trpc/tanstack-react-query options surface"],
    ["trpc.post.list.infiniteQueryOptions", "the @trpc/tanstack-react-query options surface"],
    ["trpc.post.add.mutationOptions", "the @trpc/tanstack-react-query options surface"],
    ["trpc.onAdd.subscriptionOptions", "the @trpc/tanstack-react-query options surface"],
    ["client.user.byId.query.then", "a promise continuation"],
    ["caller.user.byId", "a server-side caller, which has no terminal"],
  ])("returns null for %s — %s", (target) => {
    expect(classifyTrpcCall(makeCall({ target }), clientCtx)).toBeNull()
  })
})

describe("classifyTrpcCall — upstream contract violations", () => {
  const path = "src/pages/index.tsx"

  it.each([
    ["", "CallCandidate.target is empty"],
    ["client..user.query", 'CallCandidate.target "client..user.query" has empty segment(s)'],
    [".client.user.query", 'CallCandidate.target ".client.user.query" has empty segment(s)'],
    ["client.user.query.", 'CallCandidate.target "client.user.query." has empty segment(s)'],
  ])("throws on the malformed target %j, naming itself and the file, before the import gate", (target, message) => {
    for (const imports of [[makeTrpcClientImport()], []]) {
      expect(() => classifyTrpcCall(makeCall({ target }), makeCtx({ imports, path }))).toThrow(
        `effects-trpc (${path}): ${message}`,
      )
    }
  })

  it("throws on an import edge with an empty source rather than skipping it", () => {
    const brokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["createTRPCClient"], line: 2, dynamic: false }],
      path,
    })
    expect(() =>
      classifyTrpcCall(makeCall({ target: "client.user.byId.query" }), brokenEdge),
    ).toThrow(`effects-trpc (${path}, line 2): ImportEdge.source is empty`)
  })

  it("leaves the CallCandidate and the ClassifyContext as it found them", () => {
    const call = makeCall({ target: "client.user.create.mutate", argumentCount: 1 })
    const before = structuredClone({ call, file: clientCtx.file, owner: clientCtx.owner })
    classifyTrpcCall(call, clientCtx)
    expect({ call, file: clientCtx.file, owner: clientCtx.owner }).toEqual(before)
  })
})
