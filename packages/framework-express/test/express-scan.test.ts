import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import type { IR } from "@aburi/types"
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

/** `"<extKind> <confidence> <derivedBy tags>"` per classified Symbol in `path`, sorted. */
function classifiedIn(ir: IR, path: string): string[] {
  return ir.symbols
    .filter((s) => s.source.file === path && s.extKind !== null)
    .map((s) => {
      // The scan appends the framework plugin's tags after the language plugin's.
      const own = s.derivedBy.findIndex((tag) => tag.startsWith("framework:express:"))
      return [s.extKind, s.confidence, ...s.derivedBy.slice(own)].join(" ")
    })
    .sort()
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
