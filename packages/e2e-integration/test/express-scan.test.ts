import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { scan } from "@aburi/core"
import { expressFrameworkPlugin } from "@aburi/framework-express"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let workRoot: string

beforeEach(async () => {
  workRoot = join(tmpdir(), `aburi-scan-express-e2e-${Math.floor(performance.now() * 1000)}`)
  await mkdir(workRoot, { recursive: true })
})

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await rm(workRoot, { recursive: true, force: true })
})

async function writeSource(rel: string, content: string): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

function buildRegistry() {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(expressFrameworkPlugin.manifest)
  return registry
}

describe("scan — integration through @aburi/framework-express", () => {
  it("classifies routers, routes, middleware, error-middleware, and mounts end-to-end", async () => {
    await writeSource(
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
    await writeSource(
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

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [expressFrameworkPlugin],
      effects: [],
      registry: buildRegistry(),
    })

    const byExtKind = new Map<string, number>()
    for (const s of result.ir.symbols) {
      if (s.extKind === null) continue
      byExtKind.set(s.extKind, (byExtKind.get(s.extKind) ?? 0) + 1)
    }

    expect(byExtKind.get("framework:express:router")).toBe(1)
    expect(byExtKind.get("framework:express:route")).toBe(3)
    expect(byExtKind.get("framework:express:middleware")).toBe(1)
    expect(byExtKind.get("framework:express:error-middleware")).toBe(1)
    expect(byExtKind.get("framework:express:mount")).toBe(1)
  })

  it("downgrades confidence when the file does not import express", async () => {
    await writeSource("src/mystery.ts", `const app = someFactory()\napp.get('/', h)\n`)

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [expressFrameworkPlugin],
      effects: [],
      registry: buildRegistry(),
    })

    const route = result.ir.symbols.find((s) => s.extKind === "framework:express:route")
    expect(route?.confidence).toBe("medium")
  })

  it("leaves plain declarations without an Express shape unclassified", async () => {
    await writeSource(
      "src/mixed.ts",
      [
        `import express from "express"`,
        `const app = express()`,
        `export function formatIso(d: Date) { return d.toISOString() }`,
      ].join("\n"),
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [expressFrameworkPlugin],
      effects: [],
      registry: buildRegistry(),
    })

    const helper = result.ir.symbols.find((s) => s.name === "formatIso")
    expect(helper?.extKind).toBeNull()
  })
})
