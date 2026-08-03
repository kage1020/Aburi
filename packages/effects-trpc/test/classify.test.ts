import { describe, expect, it } from "vitest"
import { classifyTrpcCall, EFFECTS_TRPC_DERIVED_BY_PREFIX } from "../src/index"
import { makeCall, makeCtx, makeTrpcClientImport, makeTrpcServerImport } from "./fixtures/context"

const clientCtx = () => makeCtx({ imports: [makeTrpcClientImport()] })
const reactCtx = () => makeCtx({ imports: [makeTrpcClientImport("@trpc/react-query")] })
const bothCtx = () => makeCtx({ imports: [makeTrpcClientImport(), makeTrpcServerImport()] })
const serverCtx = () => makeCtx({ imports: [makeTrpcServerImport()] })

describe("classifyTrpcCall — recognized client shapes", () => {
  it("classifies a nested procedure query as network.rpc with the procedure path in derivedBy", () => {
    const result = classifyTrpcCall(makeCall({ target: "client.user.byId.query" }), clientCtx())
    expect(result).toEqual({
      effectId: "network.rpc",
      confidence: "high",
      derivedBy: `${EFFECTS_TRPC_DERIVED_BY_PREFIX}:query:user.byId`,
    })
  })

  it("classifies a top-level procedure (exactly 3 segments) and records the bare procedure name", () => {
    const result = classifyTrpcCall(makeCall({ target: "client.getUser.query" }), clientCtx())
    expect(result?.effectId).toBe("network.rpc")
    expect(result?.derivedBy).toBe(`${EFFECTS_TRPC_DERIVED_BY_PREFIX}:query:getUser`)
  })

  it("classifies the vanilla mutate terminal under the mutation family", () => {
    const result = classifyTrpcCall(
      makeCall({ target: "client.user.create.mutate", argumentCount: 1 }),
      clientCtx(),
    )
    expect(result?.effectId).toBe("network.rpc")
    expect(result?.derivedBy).toBe(`${EFFECTS_TRPC_DERIVED_BY_PREFIX}:mutation:user.create`)
  })

  it("classifies the React Query useMutation hook under the mutation family", () => {
    const result = classifyTrpcCall(
      makeCall({ target: "trpc.user.create.useMutation" }),
      reactCtx(),
    )
    expect(result?.derivedBy).toBe(`${EFFECTS_TRPC_DERIVED_BY_PREFIX}:mutation:user.create`)
  })

  it("classifies the vanilla subscribe terminal under the subscription family", () => {
    const result = classifyTrpcCall(
      makeCall({ target: "client.onAdd.subscribe", argumentCount: 2 }),
      clientCtx(),
    )
    expect(result?.effectId).toBe("network.rpc")
    expect(result?.derivedBy).toBe(`${EFFECTS_TRPC_DERIVED_BY_PREFIX}:subscription:onAdd`)
  })

  it("classifies useSubscription under the subscription family", () => {
    const result = classifyTrpcCall(makeCall({ target: "trpc.onAdd.useSubscription" }), reactCtx())
    expect(result?.derivedBy).toBe(`${EFFECTS_TRPC_DERIVED_BY_PREFIX}:subscription:onAdd`)
  })

  it.each([
    "query",
    "useQuery",
    "useInfiniteQuery",
    "useSuspenseQuery",
    "useSuspenseInfiniteQuery",
    "usePrefetchQuery",
    "usePrefetchInfiniteQuery",
  ])("maps the read terminal %s onto the query derivedBy family", (terminal) => {
    const result = classifyTrpcCall(makeCall({ target: `trpc.post.list.${terminal}` }), reactCtx())
    expect(result?.effectId).toBe("network.rpc")
    expect(result?.derivedBy).toBe(`${EFFECTS_TRPC_DERIVED_BY_PREFIX}:query:post.list`)
  })

  it("strips a leading `this` receiver before computing the procedure path", () => {
    // `this.trpc.user.byId.query()` inside a class method. Without the strip the path
    // would carry the field name (`trpc.user.byId`) and no longer match the router path
    // the same procedure produces when called through a local binding.
    const result = classifyTrpcCall(makeCall({ target: "this.trpc.user.byId.query" }), clientCtx())
    expect(result?.derivedBy).toBe(`${EFFECTS_TRPC_DERIVED_BY_PREFIX}:query:user.byId`)
  })

  it("over-qualifies the path when the client sits behind a multi-segment receiver", () => {
    // Documented limitation rather than a goal: only the FIRST segment is treated as the
    // client binding, so `api.trpc.user.byId.query()` records `trpc.user.byId`. The
    // effect id and target stay correct; nothing in the target string marks where the
    // binding ends and the router path begins. Pinned so the behaviour is a decision
    // rather than an accident.
    const result = classifyTrpcCall(makeCall({ target: "api.trpc.user.byId.query" }), clientCtx())
    expect(result?.effectId).toBe("network.rpc")
    expect(result?.derivedBy).toBe(`${EFFECTS_TRPC_DERIVED_BY_PREFIX}:query:trpc.user.byId`)
  })

  it("keeps deeply nested router paths intact in derivedBy", () => {
    const result = classifyTrpcCall(
      makeCall({ target: "client.admin.billing.invoice.byId.query" }),
      clientCtx(),
    )
    expect(result?.derivedBy).toBe(
      `${EFFECTS_TRPC_DERIVED_BY_PREFIX}:query:admin.billing.invoice.byId`,
    )
  })

  it("emits confidence high for every recognized shape (import gate + shape are two joined signals)", () => {
    for (const target of [
      "client.a.b.query",
      "client.a.b.mutate",
      "client.a.b.subscribe",
      "trpc.a.b.useQuery",
    ]) {
      expect(classifyTrpcCall(makeCall({ target }), clientCtx())?.confidence).toBe("high")
    }
  })
})

describe("classifyTrpcCall — import gate", () => {
  it("returns null for every recognized terminal when no tRPC client module is imported", () => {
    const ctx = makeCtx({ imports: [] })
    for (const target of [
      "client.user.byId.query",
      "client.user.create.mutate",
      "client.onAdd.subscribe",
      "trpc.post.list.useQuery",
    ]) {
      expect(classifyTrpcCall(makeCall({ target }), ctx)).toBeNull()
    }
  })

  it("returns null when only unrelated libraries are imported", () => {
    const ctx = makeCtx({
      imports: [
        { source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false },
        { source: "rxjs", symbols: ["Observable"], line: 2, dynamic: false },
      ],
    })
    expect(classifyTrpcCall(makeCall({ target: "store.select.pipe.subscribe" }), ctx)).toBeNull()
  })
})

describe("classifyTrpcCall — server-side shapes are not effects", () => {
  it("returns null for the procedure builder chain publicProcedure.input.query", () => {
    // Normalizes to the same 3-segment / `query`-terminal shape as a client call. The
    // `@trpc/server` import is the only available discriminator.
    expect(
      classifyTrpcCall(makeCall({ target: "publicProcedure.input.query" }), serverCtx()),
    ).toBeNull()
  })

  it("returns null for t.router and initTRPC.create", () => {
    for (const target of ["t.router", "initTRPC.create", "t.procedure.query"]) {
      expect(classifyTrpcCall(makeCall({ target }), serverCtx())).toBeNull()
    }
  })

  it("suppresses the query terminal even for a client-shaped target when @trpc/server is imported", () => {
    // Conservative: in a file that defines routers we cannot tell `client.user.byId.query`
    // apart from `someProcedure.input.query`, so nothing with a `query` terminal is
    // classified. Missing an effect beats inventing one on a router definition.
    expect(classifyTrpcCall(makeCall({ target: "client.user.byId.query" }), bothCtx())).toBeNull()
  })

  it("still classifies mutate / subscribe / hooks when @trpc/server is imported", () => {
    // The suppression is scoped to `query` alone: the server vocabulary spells its
    // counterparts `mutation` / `subscription`, so there is no collision to defend against.
    expect(
      classifyTrpcCall(makeCall({ target: "client.user.create.mutate" }), bothCtx())?.effectId,
    ).toBe("network.rpc")
    expect(
      classifyTrpcCall(makeCall({ target: "client.onAdd.subscribe" }), bothCtx())?.effectId,
    ).toBe("network.rpc")
    expect(
      classifyTrpcCall(makeCall({ target: "trpc.post.list.useQuery" }), bothCtx())?.effectId,
    ).toBe("network.rpc")
  })
})

describe("classifyTrpcCall — shapes outside the vocabulary", () => {
  it.each([
    "trpc.useUtils",
    "client.query",
    "query.foo",
    "subscribe.now",
  ])("returns null for the two-segment target %s", (target) => {
    // A tRPC client call is always `<client>.<procedure path…>.<terminal>` — at least
    // three segments. Two-segment shapes are proxy accessors or unrelated calls.
    expect(classifyTrpcCall(makeCall({ target }), clientCtx())).toBeNull()
  })

  it("returns null for a bare single-segment call", () => {
    expect(classifyTrpcCall(makeCall({ target: "query" }), clientCtx())).toBeNull()
  })

  it("returns null for `this.client.query` — the `this` strip leaves only two segments", () => {
    expect(classifyTrpcCall(makeCall({ target: "this.client.query" }), clientCtx())).toBeNull()
  })

  it("returns null for a lone `this` — the strip leaves nothing to address", () => {
    // Degenerate edge of the strip: `segments` becomes empty while `terminal` still holds
    // the pre-strip last segment. The length gate is what keeps the two from disagreeing,
    // so pin the shortest input that exercises it. It must return null, not throw.
    expect(classifyTrpcCall(makeCall({ target: "this" }), clientCtx())).toBeNull()
  })

  it.each([
    "utils.user.byId.invalidate",
    "utils.user.byId.fetch",
    "utils.post.all.ensureData",
  ])("returns null for the useUtils cache surface %s", (target) => {
    // The receiver is a local binding produced by `trpc.useUtils()`; nothing in the
    // target string proves it is tRPC-derived, and `fetch` / `prefetch` are far too
    // generic to claim.
    expect(classifyTrpcCall(makeCall({ target }), reactCtx())).toBeNull()
  })

  it.each([
    "trpc.post.list.queryOptions",
    "trpc.post.list.infiniteQueryOptions",
    "trpc.post.add.mutationOptions",
    "trpc.onAdd.subscriptionOptions",
  ])("returns null for the @trpc/tanstack-react-query options surface %s", (target) => {
    // `queryOptions()` builds an options object; the request happens in the `useQuery`
    // that consumes it. Classifying here would attach an effect to code that never
    // reaches the network.
    expect(classifyTrpcCall(makeCall({ target }), reactCtx())).toBeNull()
  })

  it("returns null for a promise continuation on a classified call", () => {
    // `await client.user.byId.query().then(cb)` normalizes to a `then` terminal. The
    // root `client.user.byId.query` is emitted as its own candidate and classifies
    // there, so dropping this one keeps it at one effect per call site.
    expect(
      classifyTrpcCall(makeCall({ target: "client.user.byId.query.then" }), clientCtx()),
    ).toBeNull()
  })

  it("returns null for the server-side caller shape caller.user.byId", () => {
    // `createCaller` procedures are invoked by their own name — there is no terminal to
    // match against the vocabulary.
    expect(classifyTrpcCall(makeCall({ target: "caller.user.byId" }), clientCtx())).toBeNull()
  })
})

describe("classifyTrpcCall — upstream contract violations", () => {
  it("throws on an empty target, including the file path in the message", () => {
    const ctx = makeCtx({ imports: [makeTrpcClientImport()], path: "src/pages/index.tsx" })
    expect(() => classifyTrpcCall(makeCall({ target: "" }), ctx)).toThrow(
      /CallCandidate\.target is empty/,
    )
    expect(() => classifyTrpcCall(makeCall({ target: "" }), ctx)).toThrow(/src\/pages\/index\.tsx/)
  })

  it("throws on adjacent / leading / trailing dots, quoting the offending target", () => {
    const ctx = makeCtx({ imports: [makeTrpcClientImport()] })
    for (const target of ["client..user.query", ".client.user.query", "client.user.query."]) {
      expect(() => classifyTrpcCall(makeCall({ target }), ctx)).toThrow(/has empty segment/)
      expect(() => classifyTrpcCall(makeCall({ target }), ctx)).toThrow(
        new RegExp(target.replace(/\./g, "\\.")),
      )
    }
  })

  it("throws on a malformed target even when the file is not a tRPC consumer", () => {
    // Fail-fast runs before the import gate so an upstream normalization bug surfaces on
    // every file rather than only in the small share that import tRPC.
    expect(() => classifyTrpcCall(makeCall({ target: "" }), makeCtx({ imports: [] }))).toThrow(
      /CallCandidate\.target is empty/,
    )
  })

  it("names itself in the message — a transposed plugin-name const would type-check silently", () => {
    // The name is now an importable const shared by four packages rather than a literal in
    // this file, so nothing but this assertion catches `EFFECTS_NEST_PLUGIN_NAME` here.
    const ctx = makeCtx({ imports: [makeTrpcClientImport()] })
    expect(() => classifyTrpcCall(makeCall({ target: "" }), ctx)).toThrow(/^effects-trpc \(/)
    const brokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["createTRPCClient"], line: 2, dynamic: false }],
    })
    expect(() =>
      classifyTrpcCall(makeCall({ target: "client.user.byId.query" }), brokenEdge),
    ).toThrow(/^effects-trpc \(/)
  })

  it("throws when an ImportEdge carries an empty source", () => {
    const ctx = makeCtx({
      imports: [{ source: "", symbols: ["createTRPCClient"], line: 2, dynamic: false }],
    })
    expect(() => classifyTrpcCall(makeCall({ target: "client.user.byId.query" }), ctx)).toThrow(
      /ImportEdge\.source is empty/,
    )
  })
})

describe("classifyTrpcCall — purity", () => {
  it("returns an identical result across repeated invocations (effect-plugin.md EP2)", () => {
    const ctx = clientCtx()
    const call = makeCall({ target: "client.user.byId.query" })
    const runs = Array.from({ length: 5 }, () => classifyTrpcCall(call, ctx))
    for (const run of runs) expect(run).toEqual(runs[0])
  })

  it("does not mutate the CallCandidate or the ClassifyContext", () => {
    const ctx = clientCtx()
    const call = makeCall({ target: "client.user.create.mutate", argumentCount: 1 })
    const callSnapshot = structuredClone(call)
    const importsSnapshot = structuredClone(ctx.file.imports)
    classifyTrpcCall(call, ctx)
    expect(call).toEqual(callSnapshot)
    expect(ctx.file.imports).toEqual(importsSnapshot)
  })
})
