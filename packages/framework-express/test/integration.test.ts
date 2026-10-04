import { extractSymbols, parseTypescriptFile } from "@aburi/lang-typescript"
import type { SymbolCandidate, SymbolClassification } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyExpressSymbol } from "../src/classify"
import { makeCtx } from "./fixtures/symbol"

interface ClassifiedRow {
  candidate: SymbolCandidate<unknown>
  classification: SymbolClassification | null
}

async function classifyFixture(path: string, source: string): Promise<ClassifiedRow[]> {
  const parsed = await parseTypescriptFile({ path, content: source })
  if (parsed.tree === null) throw new Error(`fixture ${path} failed to parse`)
  const ctx = { ...makeCtx(path, source), imports: parsed.imports }
  const candidates = extractSymbols(parsed.tree, ctx) as SymbolCandidate<unknown>[]
  return candidates.map((candidate) => ({
    candidate,
    classification: classifyExpressSymbol(candidate, ctx),
  }))
}

function findByExtKind(rows: ClassifiedRow[], extKind: string): ClassifiedRow {
  const match = rows.find((r) => r.classification?.extKind === extKind)
  if (match === undefined) {
    const summary = rows
      .map((r) => `${r.candidate.name} (${r.candidate.kind}) → ${r.classification?.extKind ?? "-"}`)
      .join("\n  ")
    throw new Error(`no symbol classified as ${extKind}; observed:\n  ${summary}`)
  }
  return match
}

describe("framework-express — plain Express app", () => {
  const source = [
    `import express from "express"`,
    ``,
    `const app = express()`,
    ``,
    `app.get('/users', (req, res) => { res.json([]) })`,
    `app.post('/users', (req, res) => { res.status(201).send() })`,
    `app.use((req, res, next) => { next() })`,
    `app.use((err, req, res, next) => { res.status(500).send(String(err)) })`,
    ``,
    `app.listen(3000)`,
  ].join("\n")

  it("classifies GET/POST as framework:express:route with high confidence", async () => {
    const rows = await classifyFixture("src/app.ts", source)
    const routes = rows.filter((r) => r.classification?.extKind === "framework:express:route")
    expect(routes).toHaveLength(2)
    for (const r of routes) {
      expect(r.classification?.confidence).toBe("high")
    }
    const methods = routes.map((r) => r.classification?.derivedBy).sort()
    expect(methods).toEqual(["framework:express:route:app.get", "framework:express:route:app.post"])
  })

  it("classifies arity-3 inline middleware", async () => {
    const rows = await classifyFixture("src/app.ts", source)
    const middleware = findByExtKind(rows, "framework:express:middleware")
    expect(middleware.classification?.confidence).toBe("high")
    expect(middleware.classification?.derivedBy).toContain("arity-3")
  })

  it("classifies arity-4 error handler distinctly from arity-3 middleware", async () => {
    const rows = await classifyFixture("src/app.ts", source)
    const err = findByExtKind(rows, "framework:express:error-middleware")
    expect(err.classification?.confidence).toBe("high")
    expect(err.classification?.derivedBy).toContain("arity-4")
  })
})

describe("framework-express — Router-based app", () => {
  const source = [
    `import express, { Router } from "express"`,
    ``,
    `const app = express()`,
    `const usersRouter = Router()`,
    `const adminRouter = express.Router()`,
    ``,
    `usersRouter.get('/', getAllUsers)`,
    `usersRouter.get('/:id', getUser)`,
    `usersRouter.post('/', createUser)`,
    ``,
    `app.use('/users', usersRouter)`,
    `app.use('/admin', adminRouter)`,
  ].join("\n")

  it("classifies both Router() and express.Router() as framework:express:router", async () => {
    const rows = await classifyFixture("src/routes.ts", source)
    const routers = rows.filter((r) => r.classification?.extKind === "framework:express:router")
    expect(routers).toHaveLength(2)
    const derived = routers.map((r) => r.classification?.derivedBy).sort()
    expect(derived).toEqual([
      "framework:express:router:Router",
      "framework:express:router:express.Router",
    ])
  })

  it("classifies mount points (app.use('/prefix', router)) as framework:express:mount", async () => {
    const rows = await classifyFixture("src/routes.ts", source)
    const mounts = rows.filter((r) => r.classification?.extKind === "framework:express:mount")
    expect(mounts).toHaveLength(2)
    for (const m of mounts) {
      expect(m.classification?.confidence).toBe("high")
      expect(m.classification?.derivedBy).toContain("router-identifier")
    }
  })

  it("classifies a mount whose path is written in backticks as the quoted one is", async () => {
    // One value written with different quotes. The language plugin names this registration by
    // the path, so a kind that read it as no path would contradict the Symbol's own id.
    const rows = await classifyFixture(
      "src/routes.ts",
      `import express from "express"\nconst app = express()\napp.use(\`/users\`, usersRouter)\n`,
    )
    const mount = findByExtKind(rows, "framework:express:mount")
    expect(mount.candidate.name).toBe("app__use__$users__d0")
    expect(mount.candidate.derivedBy).toContain("path-literal:/users")
  })

  it("classifies routes attached to a router as framework:express:route with the router as receiver", async () => {
    const rows = await classifyFixture("src/routes.ts", source)
    const routes = rows.filter((r) => r.classification?.extKind === "framework:express:route")
    expect(routes).toHaveLength(3)
    const derived = routes.map((r) => r.classification?.derivedBy).sort()
    expect(derived).toEqual([
      "framework:express:route:usersRouter.get",
      "framework:express:route:usersRouter.get",
      "framework:express:route:usersRouter.post",
    ])
  })
})

describe("framework-express — confidence downgrades without an express import", () => {
  const source = [`const app = someOtherFactory()`, `app.get('/', h)`].join("\n")

  it("still classifies but flags confidence as medium", async () => {
    const rows = await classifyFixture("src/app.ts", source)
    const route = findByExtKind(rows, "framework:express:route")
    expect(route.classification?.confidence).toBe("medium")
  })
})

describe("framework-express — CommonJS app", () => {
  const source = [
    `const express = require("express")`,
    ``,
    `const app = express()`,
    `const router = express.Router()`,
    ``,
    `router.get('/users', (req, res) => { res.json([]) })`,
    `app.use((req, res, next) => { next() })`,
    `app.use('/api', router)`,
  ].join("\n")

  it("rates every Symbol high, as an import would", async () => {
    const rows = await classifyFixture("src/app.js", source)
    const rated = rows
      .filter((r) => r.classification !== null)
      .map((r) => `${r.classification?.extKind} ${r.classification?.confidence}`)
      .sort()
    expect(rated).toEqual([
      "framework:express:middleware high",
      "framework:express:mount high",
      "framework:express:route high",
      "framework:express:router high",
    ])
  })
})

describe("framework-express — abstains", () => {
  it("returns null for non-Router const symbols", async () => {
    const rows = await classifyFixture(
      "src/misc.ts",
      `import express from "express"\nconst app = express()\nconst plain = 42\n`,
    )
    const plain = rows.find((r) => r.candidate.name === "plain")
    expect(plain?.classification).toBeNull()
  })

  it("returns null for module-level calls to non-Express methods", async () => {
    const rows = await classifyFixture(
      "src/misc.ts",
      `console.log('starting')\nSentry.captureException(new Error('x'))\n`,
    )
    // These aren't promoted to call symbols in the first place (extractor filter);
    // even if they were, classifier would still abstain.
    expect(rows.some((r) => r.classification !== null)).toBe(false)
  })
})

/**
 * The one `kind: "call"` Symbol `source` produces, classified. Throws when there is none, so a
 * row asserting an abstention cannot pass because the line stopped producing a call.
 */
async function callIn(source: string): Promise<ClassifiedRow> {
  const calls = (await classifyFixture("src/app.ts", source)).filter(
    (r) => r.candidate.kind === "call",
  )
  const [call] = calls
  if (call === undefined || calls.length > 1) {
    throw new Error(`expected one call Symbol, got: ${calls.map((r) => r.candidate.name)}`)
  }
  return call
}

/** `line` below an Express import and the app it registers on. */
const inExpressApp = (line: string) =>
  [`import express from "express"`, `const app = express()`, line].join("\n")

describe("framework-express — a route method name is not a route", () => {
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
    // A comment is no argument: counted, it would stand in the path's place and `key` would be
    // read as the handler.
    ["a delete whose only argument has a comment in front", `seen.delete(/* oldest */ key)`],
    ["a delete at the end of a chain with no route call", `db.collection("users").delete(id)`],
    ["a delete up a route call whose argument is not a path", `db.route("users").delete(recordId)`],
  ])("abstains on %s", async (_label, line) => {
    expect((await callIn(inExpressApp(line))).classification).toBeNull()
  })

  it("abstains on a cache delete in a file with no Express import", async () => {
    // Without an import a route is classified `medium`, and an unrelated `import express` added
    // later moved it to `high` on a line nobody touched: the abstention has to hold here too.
    expect((await callIn(`cache.delete("key")`)).classification).toBeNull()
  })

  // Real registrations given up on purpose. Classifying one of them moves the line the README's
  // "Not classified today" list draws, so a change here belongs with a change to that list.
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
    expect((await callIn(inExpressApp(line))).classification).toBeNull()
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
    expect((await callIn(inExpressApp(line))).classification).toEqual({
      extKind: "framework:express:route",
      derivedBy: `framework:express:route:${receiverAndMethod}`,
      confidence: "high",
    })
  })
})

describe("framework-express — a .use argument behind a wrapper", () => {
  it.each([
    [
      "a handler identifier cast to its type",
      `app.use(logger as RequestHandler)`,
      "framework:express:middleware",
      "framework:express:middleware:app.use;identifier-arg",
      "medium",
    ],
    [
      "an inline handler cast to its type",
      `app.use(((req, res, next) => next()) as RequestHandler)`,
      "framework:express:middleware",
      "framework:express:middleware:app.use;arity-3",
      "high",
    ],
    [
      "a router cast to its type",
      `app.use("/api", apiRouter as Router)`,
      "framework:express:mount",
      "framework:express:mount:app.use;router-identifier",
      "high",
    ],
  ])("classifies %s as the bare argument is", async (_label, line, extKind, derivedBy, confidence) => {
    expect((await callIn(inExpressApp(line))).classification).toEqual({
      extKind,
      derivedBy,
      confidence,
    })
  })

  it("does not read an old-style assertion, as the language plugin does not", async () => {
    expect(
      (await callIn(inExpressApp(`app.use(<RequestHandler>logger)`))).classification,
    ).toBeNull()
  })
})

describe("framework-express — a statement declaring several names", () => {
  /** `"<name> <derivedBy>"` per Symbol classified as a Router, sorted. */
  function routersIn(rows: ClassifiedRow[]): string[] {
    return rows
      .filter((r) => r.classification?.extKind === "framework:express:router")
      .map((r) => `${r.candidate.name} ${r.classification?.derivedBy}`)
      .sort()
  }

  it("classifies only the name bound to the Router call", async () => {
    const rows = await classifyFixture(
      "src/routes.ts",
      [
        `import express, { Router } from "express"`,
        `export const router = express.Router(), API_PREFIX = "/api/v1", MAX_BODY = 1024`,
        `export const limit = 10, adminRouter = express.Router()`,
        `export const usersRouter = Router(), auditRouter = express.Router()`,
      ].join("\n"),
    )
    expect(routersIn(rows)).toEqual([
      "adminRouter framework:express:router:express.Router",
      "auditRouter framework:express:router:express.Router",
      "router framework:express:router:express.Router",
      "usersRouter framework:express:router:Router",
    ])
  })

  it("classifies a Router declared in a namespace by its qualified name", async () => {
    const rows = await classifyFixture(
      "src/routes.ts",
      [
        `import { Router } from "express"`,
        `export namespace api {`,
        `  export const version = 1, router = Router()`,
        `}`,
      ].join("\n"),
    )
    expect(routersIn(rows)).toEqual(["api.router framework:express:router:Router"])
  })

  it("rates a Router declared second medium when nothing imports express", async () => {
    const rows = await classifyFixture("src/routes.ts", `const limit = 10, r = Router()\n`)
    const rated = rows
      .filter((r) => r.classification !== null)
      .map((r) => `${r.candidate.name} ${r.classification?.confidence}`)
    expect(rated).toEqual(["r medium"])
  })
})
