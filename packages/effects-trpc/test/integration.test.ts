import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { makeCtx, makeExtractionCtx } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyTrpcCall } from "../src/index"

/** Each call the TypeScript plugin finds in `source`, by target, beside what `classifyTrpcCall` makes of it. */
async function classifiedCalls(source: string, path = "src/api/users.ts") {
  const { tree, imports } = await langTypescriptPlugin.parseFile({ path, content: source })
  if (tree === null) throw new Error(`${path} did not parse`)
  const extraction = makeExtractionCtx(path, source)
  const ctx = makeCtx({ path, imports })
  return langTypescriptPlugin
    .extractSymbols(tree, extraction)
    .flatMap((symbol) => langTypescriptPlugin.walkBody(symbol, { ...extraction, symbol }).calls)
    .map((call): [string, string | null] => [
      call.target,
      classifyTrpcCall(call, ctx)?.derivedBy ?? null,
    ])
    .sort(([a], [b]) => a.localeCompare(b))
}

describe("classifyTrpcCall over calls the TypeScript plugin extracts", () => {
  it("records each procedure call of a vanilla client once, and nothing around it", async () => {
    const calls = await classifiedCalls(
      [
        'import { createTRPCClient, httpBatchLink } from "@trpc/client"',
        'import type { AppRouter } from "../server"',
        "",
        'const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api" })] })',
        "",
        "export async function loadUser(id: string) {",
        '  console.info("loading", id)',
        "  return client.user.byId.query({ id }).then((user) => user)",
        "}",
        "",
        "export async function createUser(name: string) {",
        "  return await client.user.create.mutate({ name })",
        "}",
        "",
        "export function watch() {",
        "  client.onAdd.subscribe(undefined, { onData: () => {} })",
        "}",
        "",
        "export class UserGateway {",
        "  constructor(private readonly trpc: typeof client) {}",
        "  async byId(id: string) {",
        "    return await this.trpc.user.byId.query({ id })",
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    expect(calls).toEqual([
      ["client.onAdd.subscribe", "effects-plugin:trpc:subscription:onAdd"],
      ["client.user.byId.query", "effects-plugin:trpc:query:user.byId"],
      ["client.user.byId.query.then", null],
      ["client.user.create.mutate", "effects-plugin:trpc:mutation:user.create"],
      ["console.info", null],
      ["this.trpc.user.byId.query", "effects-plugin:trpc:query:user.byId"],
    ])
  })

  it("records the React Query hooks a component calls", async () => {
    const calls = await classifiedCalls(
      [
        'import { createTRPCReact } from "@trpc/react-query"',
        'import type { AppRouter } from "../server"',
        "",
        "export function PostList() {",
        "  const trpc = createTRPCReact<AppRouter>()",
        "  const posts = trpc.post.list.useQuery()",
        "  const add = trpc.post.add.useMutation()",
        "  return { posts, add }",
        "}",
        "",
      ].join("\n"),
      "src/components/PostList.tsx",
    )

    expect(calls).toEqual([
      ["createTRPCReact", null],
      ["trpc.post.add.useMutation", "effects-plugin:trpc:mutation:post.add"],
      ["trpc.post.list.useQuery", "effects-plugin:trpc:query:post.list"],
    ])
  })

  it.each([
    [
      "a router definition, which imports @trpc/server",
      [
        'import { initTRPC } from "@trpc/server"',
        'import { z } from "zod"',
        "const t = initTRPC.create()",
        "const publicProcedure = t.procedure",
        "export function createAppRouter() {",
        "  return t.router({",
        "    user: t.router({",
        "      byId: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => input.id),",
        "    }),",
        "  })",
        "}",
      ],
    ],
    [
      "a file that imports no tRPC module",
      [
        'import { PrismaClient } from "@prisma/client"',
        "export async function listUsers(prisma: PrismaClient) {",
        "  return prisma.user.byId.query()",
        "}",
      ],
    ],
  ])("records nothing in %s", async (_label, lines) => {
    const calls = await classifiedCalls(lines.join("\n"))

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter(([, derivedBy]) => derivedBy !== null)).toEqual([])
  })
})
