import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { frameworkEntries, useScratchWorkspace } from "@aburi/test-support"
import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { expressFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("express-scan")

async function scanWorkspace(): Promise<IR> {
  const { ir } = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [expressFrameworkPlugin],
  })
  return ir
}

/** `"<extKind> <confidence> <derivedBy tags>"` for a classified Symbol. */
function classification(s: IRSymbol): string {
  return [s.extKind, s.confidence, ...frameworkEntries(s, "framework:express:")].join(" ")
}

/** `classification` per classified Symbol in `path`, sorted. */
function classifiedIn(ir: IR, path: string): string[] {
  return ir.symbols
    .filter((s) => s.source.file === path && s.extKind !== null)
    .map(classification)
    .sort()
}

/**
 * The one call Symbol `source` produces. Throws when there is not exactly one, so an abstention
 * cannot pass because no call was extracted.
 */
async function oneCallIn(source: string): Promise<IRSymbol> {
  await workspace.writeSource("src/app.ts", source)
  const ir = await scanWorkspace()
  const calls = ir.symbols.filter((s) => s.source.file === "src/app.ts" && s.kind === "call")
  const [call] = calls
  if (call === undefined || calls.length > 1) {
    throw new Error(`expected one call Symbol, got: ${calls.map((s) => s.name)}`)
  }
  return call
}

/** The `classification` of the one call Symbol `source` produces, or `null` when it is unclassified. */
async function callIn(source: string): Promise<string | null> {
  const call = await oneCallIn(source)
  return call.extKind === null ? null : classification(call)
}

/** `callIn`, for a call whose Express entry must name it as its `call-statement:` entry does. */
async function namedCallIn(source: string): Promise<string | null> {
  const call = await oneCallIn(source)
  const [entry] = frameworkEntries(call, "framework:express:")
  const statement = call.derivedBy.find((tag) => tag.startsWith("call-statement:"))
  expect(entry?.replace(/^framework:express:[a-z-]+:/, "")).toBe(
    statement?.slice("call-statement:".length),
  )
  return classification(call)
}

const inExpressApp = (line: string) =>
  [`import express from "express"`, `const app = express()`, line].join("\n")

/** `classifiedIn` for a file declaring one const, `router`, initialised by `initializer`. */
async function routerIn(initializer: string): Promise<string[]> {
  await workspace.writeSource(
    "src/app.ts",
    [`import express from "express"`, `export const router = ${initializer}`].join("\n"),
  )
  return classifiedIn(await scanWorkspace(), "src/app.ts")
}

describe("scan — an Express app", () => {
  it("classifies its routers, routes, middleware, error middleware and mounts", async () => {
    await workspace.writeSource(
      "src/users.ts",
      [
        `import { Router } from "express"`,
        ``,
        `export const usersRouter = Router()`,
        ``,
        `usersRouter.get('/', (req, res) => { res.json([]) })`,
        `usersRouter.get('/:id', (req, res) => { res.json({ id: req.params.id }) })`,
        `usersRouter.post('/', (req, res) => { res.status(201).send() })`,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/app.ts",
      [
        `import express from "express"`,
        `import { usersRouter } from "./users"`,
        ``,
        `const app = express()`,
        `const adminRouter = express.Router()`,
        ``,
        `app.use((req, res, next) => { next() })`,
        `app.use(logger)`,
        `app.use('/users', usersRouter)`,
        `app.use('/admin', adminRouter)`,
        `app.use((err, req, res, next) => { res.status(500).send(String(err)) })`,
        ``,
        `app.listen(3000)`,
      ].join("\n"),
    )

    const ir = await scanWorkspace()

    expect(classifiedIn(ir, "src/users.ts")).toEqual([
      "framework:express:route high framework:express:route:usersRouter.get",
      "framework:express:route high framework:express:route:usersRouter.get",
      "framework:express:route high framework:express:route:usersRouter.post",
      "framework:express:router high framework:express:router:Router",
    ])
    expect(classifiedIn(ir, "src/app.ts")).toEqual([
      "framework:express:error-middleware high framework:express:error-middleware:app.use arity-4",
      "framework:express:middleware high framework:express:middleware:app.use arity-3",
      "framework:express:middleware medium framework:express:middleware:app.use identifier-arg",
      "framework:express:mount high framework:express:mount:app.use router-identifier",
      "framework:express:mount high framework:express:mount:app.use router-identifier",
      "framework:express:router high framework:express:router:express.Router",
    ])
  })

  it("rates the same shapes medium in a file that does not import express", async () => {
    await workspace.writeSource(
      "src/mystery.ts",
      [
        `const app = someFactory()`,
        `const router = Router()`,
        `app.get('/', h)`,
        `app.use((req, res, next) => next())`,
        `app.use('/api', router)`,
      ].join("\n"),
    )

    const ir = await scanWorkspace()

    expect(classifiedIn(ir, "src/mystery.ts")).toEqual([
      "framework:express:middleware medium framework:express:middleware:app.use arity-3",
      "framework:express:mount medium framework:express:mount:app.use router-identifier",
      "framework:express:route medium framework:express:route:app.get",
      "framework:express:router medium framework:express:router:Router",
    ])
  })

  it("leaves what has no Express shape unclassified", async () => {
    await workspace.writeSource(
      "src/misc.ts",
      [
        `import express from "express"`,
        `const app = express()`,
        `const limit = 42`,
        `console.log("starting")`,
        `app.use((req, res) => res.end())`,
        `app.listen(3000)`,
        `export function formatIso(d: Date) { return d.toISOString() }`,
      ].join("\n"),
    )

    const ir = await scanWorkspace()
    const symbols = ir.symbols.filter((s) => s.source.file === "src/misc.ts")

    expect(symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining(["app", "limit", "formatIso"]),
    )
    expect(classifiedIn(ir, "src/misc.ts")).toEqual([])
  })

  it("classifies only the names bound to a Router call in statements declaring several", async () => {
    await workspace.writeSource(
      "src/routes.ts",
      [
        `import express, { Router } from "express"`,
        `export const router = express.Router(), API_PREFIX = "/api/v1", MAX_BODY = 1024`,
        `export const limit = 10, adminRouter = express.Router()`,
        `export const usersRouter = Router(), auditRouter = express.Router()`,
      ].join("\n"),
    )

    const ir = await scanWorkspace()

    expect(
      ir.symbols
        .filter((s) => s.extKind === "framework:express:router")
        .map((s) => s.name)
        .sort(),
    ).toEqual(["adminRouter", "auditRouter", "router", "usersRouter"])
  })
})

describe("scan — a route method name is not a route", () => {
  it.each([
    ["Express's settings getter", `app.get("env")`],
    ["a cache delete", `cache.delete("stale-key")`],
    ["a settings read", `settings.get("port")`],
    ["a Map delete", `seen.delete(process.argv[2])`],
    ["a URLSearchParams delete", `url.searchParams.delete("sslmode")`],
    ["an HTTP client posting data", `axios.post(url, { id: 1 })`],
    ["a call with no arguments", `client.get()`],
    ["an HTTP client passing options", `client.get(url, { headers: { accept: "json" } })`],
    ["a delete handed a list of keys", `cache.delete("users", ["a", "b"])`],
    ["a get handed a choice of defaults", `config.get("port", isProd ? 80 : 3000)`],
    ["a put handed a computed value", `cache.put(key, count + 1)`],
    ["a getter whose only other argument is a comment", `app.get("env" /* the mode */)`],
    // Counted as an argument, the comment would stand in the path's place, `key` as the handler.
    ["a delete whose only argument has a comment in front", `seen.delete(/* oldest */ key)`],
    ["a delete at the end of a chain with no route call", `db.collection("users").delete(id)`],
    ["a delete up a route call whose argument is not a path", `db.route("users").delete(recordId)`],
  ])("abstains on %s", async (_label, line) => {
    expect(await callIn(inExpressApp(line))).toBeNull()
  })

  it("abstains on a cache delete in a file with no Express import", async () => {
    // A route there is rated medium, and an unrelated `import express` added later made it high.
    expect(await callIn(`cache.delete("key")`)).toBeNull()
  })

  // Real registrations left unclassified on purpose, each one a documented limit of the plugin.
  it.each([
    ["a handler that is awaited", `app.get("/users", await makeHandler())`],
    ["a handler that is constructed", `app.get("/users", new AsyncHandler(listUsers))`],
    ["a handler behind an old-style assertion", `app.get("/users", <RequestHandler>listUsers)`],
    [
      "an app.route chain bound to a name first",
      `const userRoute = app.route("/users")\nuserRoute.get(listUsers)`,
    ],
    ["an app.route chain whose path is a name", `app.route(USERS_PATH).get(listUsers)`],
  ])("knowingly abstains on %s", async (_label, line) => {
    expect(await callIn(inExpressApp(line))).toBeNull()
  })

  it.each([
    ["an inline handler", `app.get("/users", (req, res) => res.json([]))`, "app.get"],
    ["a handler identifier", `app.get("/users", listUsers)`, "app.get"],
    ["a controller method", `app.get("/users", users.list)`, "app.get"],
    [
      "a wrapped inline handler",
      `app.get("/users", asyncHandler(async (req, res) => res.json([])))`,
      "app.get",
    ],
    [
      "middleware before the handler",
      `app.post("/users", validate(schema), createUser)`,
      "app.post",
    ],
    [
      "its path up an app.route chain",
      `app.route("/users").get((req, res) => res.json([]))`,
      "app.get",
    ],
    ["a handler identifier up an app.route chain", `app.route("/users").get(listUsers)`, "app.get"],
    // One statement is one Symbol, named by the leaf call.
    [
      "several methods on one app.route chain",
      `app.route("/users").get(listUsers).post(createUser)`,
      "app.post",
    ],
    [
      "an app.route chain with a non-null assertion",
      `app.route("/users")!.get(listUsers)`,
      "app.get",
    ],
    ["an app.route path in backticks", "app.route(`/users`).get(listUsers)", "app.get"],
    ["an array of handlers", `app.get("/users", [authenticate, listUsers])`, "app.get"],
    ["a spread of handlers", `app.get("/users", ...handlers)`, "app.get"],
    ["a spread carrying the path as well", `app.get(...routeArgs)`, "app.get"],
    ["a wrapped handler identifier", `app.get("/users", asyncHandler(listUsers))`, "app.get"],
    ["a bound controller method", `app.get("/users", users.list.bind(users))`, "app.get"],
    ["a handler cast to its type", `app.get("/users", listUsers as RequestHandler)`, "app.get"],
    ["a handler picked by key", `app.get("/users", handlers["list"])`, "app.get"],
    [
      "a handler picked by a condition",
      `app.get("/users", isProd ? cachedList : liveList)`,
      "app.get",
    ],
    ["a handler with a || fallback", `app.get("/users", custom || defaultHandler)`, "app.get"],
    ["a handler with a ?? fallback", `app.get("/users", options.handler ?? fallback)`, "app.get"],
    [
      "a handler factory handed only options",
      `app.get("/auth/google", passport.authenticate("google", { scope: ["profile"] }))`,
      "app.get",
    ],
  ])("classifies a route with %s", async (_label, line, receiverAndMethod) => {
    expect(await callIn(inExpressApp(line))).toBe(
      `framework:express:route high framework:express:route:${receiverAndMethod}`,
    )
  })
})

describe("scan — a .use argument behind a wrapper", () => {
  it.each([
    [
      "a handler identifier cast to its type",
      `app.use(logger as RequestHandler)`,
      "framework:express:middleware medium framework:express:middleware:app.use identifier-arg",
    ],
    [
      "an inline handler cast to its type",
      `app.use(((req, res, next) => next()) as RequestHandler)`,
      "framework:express:middleware high framework:express:middleware:app.use arity-3",
    ],
    [
      "a router cast to its type",
      `app.use("/api", apiRouter as Router)`,
      "framework:express:mount high framework:express:mount:app.use router-identifier",
    ],
  ])("classifies %s as the bare argument is", async (_label, line, expected) => {
    expect(await callIn(inExpressApp(line))).toBe(expected)
  })

  it("does not read an old-style assertion, as the language plugin does not", async () => {
    expect(await callIn(inExpressApp(`app.use(<RequestHandler>logger)`))).toBeNull()
  })
})

describe("scan — a call's derivedBy", () => {
  it.each([
    [
      "a route chain wrapped over several lines",
      `app\n  .route("/users/:id")\n  .get(getUser)\n  .delete(deleteUser)`,
      `app.route("/users/:id").get(getUser).delete(deleteUser)`,
      "framework:express:route high framework:express:route:app.delete",
    ],
    [
      "a route with a line comment in its chain",
      `app // users\n  .get("/users", listUsers)`,
      `app.get("/users", listUsers)`,
      "framework:express:route high framework:express:route:app.get",
    ],
    [
      "a route whose dot ends a line",
      `app.\n  get("/users", listUsers)`,
      `app.get("/users", listUsers)`,
      "framework:express:route high framework:express:route:app.get",
    ],
    [
      "a route on a receiver cast to its type",
      `;(app as Express).get("/users", listUsers)`,
      `app.get("/users", listUsers)`,
      "framework:express:route high framework:express:route:app.get",
    ],
    [
      "a route on a receiver that satisfies its type",
      `;(app satisfies Express).get("/users", listUsers)`,
      `app.get("/users", listUsers)`,
      "framework:express:route high framework:express:route:app.get",
    ],
    [
      "a route on a receiver with a non-null assertion",
      `app!.get("/users", listUsers)`,
      `app.get("/users", listUsers)`,
      "framework:express:route high framework:express:route:app.get",
    ],
    [
      "error middleware after a comment holding a ;",
      `app // admin; see the runbook\n  .use((err, req, res, next) => res.end())`,
      `app.use((err, req, res, next) => res.end())`,
      "framework:express:error-middleware high framework:express:error-middleware:app.use arity-4",
    ],
    [
      "a mount wrapped over two lines",
      `app\n  .use("/api", adminRouter)`,
      `app.use("/api", adminRouter)`,
      "framework:express:mount high framework:express:mount:app.use router-identifier",
    ],
    [
      "middleware after a block comment",
      `app /* logs */ .use((req, res, next) => next())`,
      `app.use((req, res, next) => next())`,
      "framework:express:middleware high framework:express:middleware:app.use arity-3",
    ],
  ])("names %s as its one-line spelling does", async (_label, written, oneLine, expected) => {
    expect(await namedCallIn(inExpressApp(written))).toBe(expected)
    expect(await namedCallIn(inExpressApp(oneLine))).toBe(expected)
  })

  it.each([
    [
      "a mount chained after middleware",
      `app.use(cors()).use("/api", adminRouter)`,
      "framework:express:mount high framework:express:mount:app.use router-identifier",
    ],
    [
      "error middleware chained after a path's middleware",
      `app.use('/a; b', audit).use((err, req, res, next) => res.end())`,
      "framework:express:error-middleware high framework:express:error-middleware:app.use arity-4",
    ],
    [
      "a route on a Router made in the statement",
      `express.Router().get("/users", listUsers)`,
      "framework:express:route high framework:express:route:express.get",
    ],
    [
      "a route chained past a call on a receiver cast to its type",
      `;(app as Express).route("/users").get(listUsers)`,
      "framework:express:route high framework:express:route:app.get",
    ],
  ])("names %s by the name its chain starts from", async (_label, line, expected) => {
    expect(await namedCallIn(inExpressApp(line))).toBe(expected)
  })

  it.each([
    [
      "a factory wrapped onto a second line after a comment",
      "express /* v5 */\n  .Router()",
      "express.Router",
    ],
    ["a factory on a receiver cast to its type", "(express as any).Router()", "express.Router"],
    ["a factory reached through require", `require("express").Router()`, "require.Router"],
  ])("names a Router made by %s", async (_label, initializer, callee) => {
    expect(await routerIn(initializer)).toEqual([
      `framework:express:router high framework:express:router:${callee}`,
    ])
  })
})
