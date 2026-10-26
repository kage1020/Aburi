import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { frameworkEntries, symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { trpcFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("trpc-scan")

const SERVER_IMPORT = `import { initTRPC } from "@trpc/server"`

async function scanWorkspace(): Promise<IR> {
  const { ir } = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [trpcFrameworkPlugin],
  })
  return ir
}

/** `"<extKind> <confidence> <derivedBy tags>"` for a classified Symbol, `null` for any other. */
function classification(s: IRSymbol): string | null {
  if (s.extKind === null) return null
  return [s.extKind, s.confidence, ...frameworkEntries(s, "framework:trpc:")].join(" ")
}

/** `"<name> <classification>"` per classified Symbol in `path`, sorted. */
function classifiedIn(ir: IR, path: string): string[] {
  return ir.symbols
    .filter((s) => s.source.file === path && s.extKind !== null)
    .map((s) => `${s.name} ${classification(s)}`)
    .sort()
}

/** The classification of `subject`, declared as `export const subject = <initializer>` under `header`. */
async function subjectIn(initializer: string, header = SERVER_IMPORT): Promise<string | null> {
  await workspace.writeSource(
    "src/server.ts",
    [header, `export const subject = ${initializer}`].join("\n"),
  )
  return classification(symbolNamed({ ir: await scanWorkspace() }, "subject"))
}

describe("scan — a tRPC server laid out as create-t3-app writes it", () => {
  it("classifies the instance, base procedures, middleware, procedures and routers in every file", async () => {
    await workspace.writeSource(
      "src/server/api/trpc.ts",
      [
        `import { initTRPC, TRPCError } from "@trpc/server"`,
        `const t = initTRPC.context<Context>().create({ transformer: superjson })`,
        `export const createCallerFactory = t.createCallerFactory`,
        `export const createTRPCRouter = t.router`,
        `const timingMiddleware = t.middleware(async ({ next }) => next())`,
        `export const publicProcedure = t.procedure.use(timingMiddleware)`,
        `export const protectedProcedure = t.procedure`,
        `  .use(timingMiddleware)`,
        `  .use(({ ctx, next }) => {`,
        `    if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" })`,
        `    return next({ ctx })`,
        `  })`,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/server/api/routers/post.ts",
      [
        `import { z } from "zod"`,
        `import { createTRPCRouter, publicProcedure } from "~/server/api/trpc"`,
        `export const latest = publicProcedure.query(({ ctx }) => ctx.db.post.findFirst())`,
        `export const postRouter = createTRPCRouter({ latest })`,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/server/api/root.ts",
      [
        `import { postRouter } from "~/server/api/routers/post"`,
        `import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc"`,
        `export const appRouter = createTRPCRouter({ post: postRouter })`,
        `export const createCaller = createCallerFactory(appRouter)`,
      ].join("\n"),
    )

    const ir = await scanWorkspace()

    expect(classifiedIn(ir, "src/server/api/trpc.ts")).toEqual([
      "protectedProcedure framework:trpc:base-procedure high framework:trpc:base-procedure:t.use",
      "publicProcedure framework:trpc:base-procedure high framework:trpc:base-procedure:t.use",
      "t framework:trpc:instance high framework:trpc:instance:initTRPC.create",
      "timingMiddleware framework:trpc:middleware high framework:trpc:middleware:t.middleware",
    ])
    expect(classifiedIn(ir, "src/server/api/routers/post.ts")).toEqual([
      "latest framework:trpc:procedure medium framework:trpc:procedure:publicProcedure.query",
      "postRouter framework:trpc:router medium framework:trpc:router:createTRPCRouter",
    ])
    expect(classifiedIn(ir, "src/server/api/root.ts")).toEqual([
      "appRouter framework:trpc:router medium framework:trpc:router:createTRPCRouter",
    ])
  })

  it("keeps a procedure's resolver as its body, so its calls are the procedure's", async () => {
    await workspace.writeSource(
      "src/server.ts",
      [
        SERVER_IMPORT,
        `export const byId = publicProcedure`,
        `  .input(z.object({ id: z.string() }))`,
        `  .query(({ ctx, input }) => ctx.db.user.findUnique({ where: { id: input.id } }))`,
      ].join("\n"),
    )

    const byId = symbolNamed({ ir: await scanWorkspace() }, "byId")

    expect(byId.extKind).toBe("framework:trpc:procedure")
    expect(byId.calls.map((call) => call.target)).toEqual(["ctx.db.user.findUnique"])
  })
})

describe("scan — what a const's initializer makes it", () => {
  it.each([
    ["the instance initTRPC creates", "initTRPC.create()", "instance:initTRPC.create"],
    [
      "an instance configured on the way",
      "initTRPC.context<Context>().meta<Meta>().create({ transformer })",
      "instance:initTRPC.create",
    ],
    ["a router the instance builds", "t.router({ user: userRouter })", "router:t.router"],
    [
      "a router built through an alias of the instance's factory",
      `router({ greeting: publicProcedure.query(() => "hi") })`,
      "router:router",
    ],
    ["create-t3-app's router factory", "createTRPCRouter({})", "router:createTRPCRouter"],
    ["routers merged on the instance", "t.mergeRouters(a, b)", "router:t.mergeRouters"],
    ["routers merged by the standalone helper", "mergeRouters(a, b)", "router:mergeRouters"],
    ["a router behind satisfies", "t.router({}) satisfies AnyRouter", "router:t.router"],
    [
      "a query",
      "publicProcedure.input(z.string()).query(({ input }) => find(input))",
      "procedure:publicProcedure.query",
    ],
    [
      "a mutation",
      "protectedProcedure.mutation(async ({ input }) => save(input))",
      "procedure:protectedProcedure.mutation",
    ],
    [
      "a subscription built straight off the instance",
      "t.procedure.subscription(() => observable(emit))",
      "procedure:t.subscription",
    ],
    [
      "a resolver declared elsewhere",
      "publicProcedure.query(listUsers)",
      "procedure:publicProcedure.query",
    ],
    [
      "a builder behind a type assertion",
      "(publicProcedure as typeof base).query(() => 1)",
      "procedure:publicProcedure.query",
    ],
    [
      "a chain wrapped over lines with a comment in it",
      "publicProcedure\n  .input(schema)\n  // by id\n  .query(({ input }) => find(input))",
      "procedure:publicProcedure.query",
    ],
    ["the instance's procedure", "t.procedure", "base-procedure:t.procedure"],
    ["a procedure with middleware", "t.procedure.use(isAuthed)", "base-procedure:t.use"],
    [
      "a base procedure extending another",
      "protectedProcedure.use(isAdmin)",
      "base-procedure:protectedProcedure.use",
    ],
    [
      "a base procedure fixing an input",
      "publicProcedure.input(z.object({ id: z.string() }))",
      "base-procedure:publicProcedure.input",
    ],
    [
      "a middleware the instance builds",
      "t.middleware(async ({ next }) => next())",
      "middleware:t.middleware",
    ],
    ["a middleware built through an alias", "middleware(enforceAuth)", "middleware:middleware"],
  ])("%s is classified", async (_shape, initializer, entry) => {
    const role = entry.slice(0, entry.indexOf(":"))
    expect(await subjectIn(initializer)).toBe(`framework:trpc:${role} high framework:trpc:${entry}`)
  })

  it.each([
    ["a query on something that is not a procedure", "db.query(() => rows())"],
    ["a client call", "client.user.byId.query({ id: 1 })"],
    ["a procedure terminal handed no resolver", "publicProcedure.query()"],
    ["a step tRPC's builder does not have", "publicProcedure.pipe(transform)"],
    ["another library's router factory", "createRouter({ routes })"],
    ["a router factory handed no procedures", `router("/api")`],
    ["another library's create", "Store.create()"],
    ["an alias of the instance's router factory", "t.router"],
    ["an alias of the instance's middleware factory", "t.middleware"],
    ["a middleware factory handed no function", "t.middleware({ name: 'timing' })"],
  ])("%s is not classified", async (_shape, initializer) => {
    expect(await subjectIn(initializer)).toBeNull()
  })

  it("reads only the const's own declarator", async () => {
    await workspace.writeSource(
      "src/server.ts",
      [SERVER_IMPORT, `export const version = 1, appRouter = t.router({})`].join("\n"),
    )

    expect(classifiedIn(await scanWorkspace(), "src/server.ts")).toEqual([
      "appRouter framework:trpc:router high framework:trpc:router:t.router",
    ])
  })
})

describe("scan — the confidence a file's imports give", () => {
  it.each([
    ["@trpc/server", `import { initTRPC } from "@trpc/server"`, "high"],
    ["a type-only import of it", `import type { AnyRouter } from "@trpc/server"`, "high"],
    [
      "one of its subpaths",
      `import { fetchRequestHandler } from "@trpc/server/adapters/fetch"`,
      "high",
    ],
    ["only the client package", `import { createTRPCClient } from "@trpc/client"`, "medium"],
    [
      "a package sharing its name's prefix",
      `import { helper } from "@trpc/server-utils"`,
      "medium",
    ],
    ["nothing", "", "medium"],
  ])("a file importing %s is %s", async (_imports, header, confidence) => {
    await workspace.writeSource(
      "src/server.ts",
      [header, `export const appRouter = createTRPCRouter({})`].join("\n"),
    )

    const appRouter = symbolNamed({ ir: await scanWorkspace() }, "appRouter")

    expect(appRouter.extKind).toBe("framework:trpc:router")
    expect(appRouter.confidence).toBe(confidence)
  })
})
