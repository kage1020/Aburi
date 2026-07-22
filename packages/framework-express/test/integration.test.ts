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
  const ctx = makeCtx(path, source)
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
