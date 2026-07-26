import {
  extractSymbols as extractTypescriptSymbols,
  parseTypescriptFile,
  walkBody as walkTypescriptBody,
} from "@aburi/lang-typescript"
import type {
  ExtractionContext,
  ImportEdge,
  SourceFile,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { classifyTrpcCall } from "../src/index"
import { makeOwner, noopRegistry } from "./fixtures/context"

/**
 * End-to-end: parse a TypeScript source through `@aburi/lang-typescript`, walk each
 * Symbol's body to produce CallCandidate[], and confirm the tRPC classifier assigns the
 * right effect ids per call. Locks the wire between call extraction in the language
 * plugin and effect classification here — in particular the `normalizeCallee` behaviour
 * of collapsing a receiver-side `call_expression`, which is what makes the client
 * `client.user.byId.query` and the server `publicProcedure.input.query` share a shape.
 */

const CLIENT_IMPORT: ImportEdge = {
  source: "@trpc/client",
  symbols: ["createTRPCClient", "httpBatchLink"],
  line: 1,
  dynamic: false,
}

const REACT_IMPORT: ImportEdge = {
  source: "@trpc/react-query",
  symbols: ["createTRPCReact"],
  line: 1,
  dynamic: false,
}

const SERVER_IMPORT: ImportEdge = {
  source: "@trpc/server",
  symbols: ["initTRPC"],
  line: 1,
  dynamic: false,
}

async function classifyCalls(path: string, source: string, imports: readonly ImportEdge[]) {
  const parseResult = await parseTypescriptFile({ path, content: source })
  const tree = parseResult.tree
  if (tree === null) throw new Error("parse returned null")
  const file: SourceFile = { path, content: source }
  const extractCtx: ExtractionContext = { file, registry: noopRegistry, config: {} }
  const candidates: SymbolCandidate<Node>[] = extractTypescriptSymbols(tree, extractCtx)
  const results: Array<{
    symbolName: string
    target: string
    effectId: string | null
    derivedBy: string | null
  }> = []
  for (const symbol of candidates) {
    const walkCtx: WalkContext<Node> = { ...extractCtx, symbol }
    const { calls } = walkTypescriptBody(symbol, walkCtx)
    for (const call of calls) {
      const classification = classifyTrpcCall(call, {
        owner: makeOwner({ id: symbol.id, name: symbol.name, kind: symbol.kind }),
        file: { path, imports: [...imports] },
        language: "ts",
        registry: noopRegistry,
        config: {},
      })
      results.push({
        symbolName: symbol.name,
        target: call.target,
        effectId: classification?.effectId ?? null,
        derivedBy: classification?.derivedBy ?? null,
      })
    }
  }
  return results
}

describe("integration — lang-typescript walkBody → effects-trpc classify", () => {
  it("classifies a vanilla client query as exactly one network.rpc", async () => {
    const results = await classifyCalls(
      "src/api/users.ts",
      `import { createTRPCClient, httpBatchLink } from "@trpc/client"
import type { AppRouter } from "../server"
const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api" })] })
export async function loadUser(id: string) {
  return await client.user.byId.query({ id })
}`,
      [CLIENT_IMPORT],
    )
    const rpcs = results.filter((r) => r.effectId === "network.rpc")
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0]?.target).toBe("client.user.byId.query")
    expect(rpcs[0]?.derivedBy).toBe("effects-plugin:trpc:query:user.byId")
  })

  it("classifies a vanilla mutate call and leaves the client construction alone", async () => {
    const results = await classifyCalls(
      "src/api/users.ts",
      `import { createTRPCClient, httpBatchLink } from "@trpc/client"
import type { AppRouter } from "../server"
export async function createUser(name: string) {
  const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api" })] })
  return await client.user.create.mutate({ name })
}`,
      [CLIENT_IMPORT],
    )
    const rpcs = results.filter((r) => r.effectId === "network.rpc")
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0]?.derivedBy).toBe("effects-plugin:trpc:mutation:user.create")
    expect(results.find((r) => r.target === "createTRPCClient")?.effectId).toBeNull()
  })

  it("classifies React Query hooks inside a component (useQuery + useMutation)", async () => {
    const results = await classifyCalls(
      "src/components/PostList.tsx",
      `import { createTRPCReact } from "@trpc/react-query"
import type { AppRouter } from "../server"
const trpc = createTRPCReact<AppRouter>()
export function PostList() {
  const posts = trpc.post.list.useQuery()
  const add = trpc.post.add.useMutation()
  return { posts, add }
}`,
      [REACT_IMPORT],
    )
    const rpcs = results.filter((r) => r.effectId === "network.rpc")
    expect(rpcs).toHaveLength(2)
    expect(rpcs.map((r) => r.derivedBy)).toEqual([
      "effects-plugin:trpc:query:post.list",
      "effects-plugin:trpc:mutation:post.add",
    ])
  })

  it("classifies this.<client>.<path>.query inside a class method", async () => {
    const results = await classifyCalls(
      "src/services/UserGateway.ts",
      `import { createTRPCClient } from "@trpc/client"
import type { AppRouter } from "../server"
export class UserGateway {
  constructor(private readonly trpc: ReturnType<typeof createTRPCClient<AppRouter>>) {}
  async byId(id: string) {
    return await this.trpc.user.byId.query({ id })
  }
}`,
      [CLIENT_IMPORT],
    )
    const call = results.find((r) => r.target === "this.trpc.user.byId.query")
    expect(call?.effectId).toBe("network.rpc")
    expect(call?.derivedBy).toBe("effects-plugin:trpc:query:user.byId")
  })

  it("assigns no effect at all to a router definition file", async () => {
    // The load-bearing guarantee behind keeping the server side out of this plugin.
    // `publicProcedure.input(z).query(cb)` normalizes to `publicProcedure.input.query` —
    // structurally identical to a client call — so a regression here would decorate
    // every router definition with a spurious network.rpc.
    // Written as a router factory so the definition sits inside a Symbol body and
    // walkBody actually emits the calls — a top-level `const appRouter = t.router({...})`
    // produces no CallCandidate at all and would make this test vacuous.
    const results = await classifyCalls(
      "src/server/router.ts",
      `import { initTRPC } from "@trpc/server"
import { z } from "zod"
const t = initTRPC.create()
const publicProcedure = t.procedure
export function createAppRouter() {
  return t.router({
    user: t.router({
      byId: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => input.id),
      create: publicProcedure.input(z.object({ name: z.string() })).mutation(({ input }) => input),
    }),
  })
}`,
      [SERVER_IMPORT],
    )
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) expect(result.effectId).toBeNull()
    expect(results.map((r) => r.target)).toContain("publicProcedure.input.query")
  })

  it("does not classify a promise continuation on an already-classified call", async () => {
    const results = await classifyCalls(
      "src/api/chained.ts",
      `import { createTRPCClient } from "@trpc/client"
import type { AppRouter } from "../server"
declare const client: ReturnType<typeof createTRPCClient<AppRouter>>
export function loadUser(id: string) {
  return client.user.byId.query({ id }).then((user) => user)
}`,
      [CLIENT_IMPORT],
    )
    const rpcs = results.filter((r) => r.effectId === "network.rpc")
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0]?.target).toBe("client.user.byId.query")
    expect(results.find((r) => r.target === "client.user.byId.query.then")?.effectId).toBeNull()
  })

  it("leaves non-tRPC calls unclassified even when a tRPC client is imported", async () => {
    const results = await classifyCalls(
      "src/api/mixed.ts",
      `import { createTRPCClient } from "@trpc/client"
import type { AppRouter } from "../server"
declare const client: ReturnType<typeof createTRPCClient<AppRouter>>
export async function work(id: string) {
  console.log("loading", id)
  return await client.user.byId.query({ id })
}`,
      [CLIENT_IMPORT],
    )
    expect(results.find((r) => r.target === "console.log")?.effectId).toBeNull()
    expect(results.find((r) => r.target === "client.user.byId.query")?.effectId).toBe("network.rpc")
  })

  it("returns null for every call when no tRPC module is imported (cross-plugin non-interference)", async () => {
    // A Prisma-only file. `prisma.user.findMany` is the Prisma plugin's business; tRPC
    // must leave the call in Symbol.calls[] for it.
    const results = await classifyCalls(
      "src/services/prisma-only.ts",
      `import { PrismaClient } from "@prisma/client"
export async function listUsers(prisma: PrismaClient) {
  return prisma.user.findMany()
}`,
      [{ source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false }],
    )
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) expect(result.effectId).toBeNull()
  })

  it("emits derivedBy under the shared effects-plugin:trpc prefix", async () => {
    const results = await classifyCalls(
      "src/api/prefix-check.ts",
      `import { createTRPCClient } from "@trpc/client"
import type { AppRouter } from "../server"
declare const client: ReturnType<typeof createTRPCClient<AppRouter>>
export async function work() {
  await client.user.byId.query({ id: "1" })
  await client.user.create.mutate({ name: "x" })
  client.onAdd.subscribe(undefined, { onData: () => {} })
}`,
      [CLIENT_IMPORT],
    )
    const classified = results.filter((r) => r.derivedBy !== null)
    expect(classified).toHaveLength(3)
    for (const result of classified) {
      expect(result.derivedBy?.startsWith("effects-plugin:trpc:")).toBe(true)
    }
  })
})
