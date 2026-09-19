import { expressFrameworkPlugin } from "@aburi/framework-express"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

const workspace = useScratchWorkspace("scan-express-e2e")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [expressFrameworkPlugin],
  })

describe("scan — integration through @aburi/framework-express", () => {
  it("classifies routers, routes, middleware, error-middleware, and mounts end-to-end", async () => {
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
        ``,
        `app.use((req, res, next) => { next() })`,
        `app.use('/users', usersRouter)`,
        `app.use((err, req, res, next) => { res.status(500).send(String(err)) })`,
        ``,
        `app.listen(3000)`,
      ].join("\n"),
    )

    const result = await scanWorkspace()

    const byExtKind = new Map<string, number>()
    for (const symbol of result.ir.symbols) {
      if (symbol.extKind === null) continue
      byExtKind.set(symbol.extKind, (byExtKind.get(symbol.extKind) ?? 0) + 1)
    }

    expect(byExtKind.get("framework:express:router")).toBe(1)
    expect(byExtKind.get("framework:express:route")).toBe(3)
    expect(byExtKind.get("framework:express:middleware")).toBe(1)
    expect(byExtKind.get("framework:express:error-middleware")).toBe(1)
    expect(byExtKind.get("framework:express:mount")).toBe(1)
  })

  it("downgrades confidence when the file does not import express", async () => {
    await workspace.writeSource("src/mystery.ts", `const app = someFactory()\napp.get('/', h)\n`)

    const result = await scanWorkspace()

    const route = result.ir.symbols.find((s) => s.extKind === "framework:express:route")
    expect(route?.confidence).toBe("medium")
  })

  it("leaves plain declarations without an Express shape unclassified", async () => {
    await workspace.writeSource(
      "src/mixed.ts",
      [
        `import express from "express"`,
        `const app = express()`,
        `export function formatIso(d: Date) { return d.toISOString() }`,
      ].join("\n"),
    )

    const result = await scanWorkspace()

    const helper = result.ir.symbols.find((s) => s.name === "formatIso")
    expect(helper?.extKind).toBeNull()
  })
})
