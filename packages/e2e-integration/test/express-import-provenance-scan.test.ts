import { expressFrameworkPlugin } from "@aburi/framework-express"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * framework-express rates a Symbol `high` when its file imports `express` and `medium`
 * otherwise. The question is read off the file's parsed imports, and off its text with comments
 * skipped where those name no `express`, so the line breaks an import is written with do not
 * move it, an import that is only a comment does not count, and a `require` does.
 */

const workspace = useScratchWorkspace("express-import-provenance")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [expressFrameworkPlugin],
  })

const ROUTES = [
  "",
  "export const router = Router()",
  "",
  'router.get("/users", (req: Request, res: Response) => res.json([]))',
  "",
  "router.use((req: Request, res: Response, next: NextFunction) => next())",
  "",
]

async function confidencesOf(path: string, lines: string[]): Promise<string[]> {
  await workspace.writeSource(path, lines.join("\n"))
  const { ir } = await scanWorkspace()
  return ir.symbols
    .filter((s) => s.source.file === path && s.extKind?.startsWith("framework:express:"))
    .map((s) => `${s.name} ${s.confidence}`)
    .sort()
}

describe("scan — where framework-express reads the express import from", () => {
  it("rates a file the same whether its import is on one line or wrapped", async () => {
    const oneLine = await confidencesOf("src/routes.ts", [
      'import { Router, type NextFunction, type Request, type Response } from "express"',
      ...ROUTES,
    ])
    const wrapped = await confidencesOf("src/routes.ts", [
      "import {",
      "  Router,",
      "  type NextFunction,",
      "  type Request,",
      "  type Response,",
      '} from "express"',
      ...ROUTES,
    ])

    expect(oneLine).toEqual(["router high", "router__get__$users__d0 high", "router__use__d0 high"])
    expect(wrapped).toEqual(oneLine)
  })

  it("does not count an import that is only a comment", async () => {
    const confidences = await confidencesOf("src/app.ts", [
      '// was: import express from "express"',
      'import { Hono } from "hono"',
      "",
      "export const app = new Hono()",
      "",
      'app.get("/users", (c) => c.json([]))',
      "",
    ])

    expect(confidences).toEqual(["app__get__$users__d0 medium"])
  })

  it("counts a CommonJS `require`, which has no import edge", async () => {
    const confidences = await confidencesOf("src/server.js", [
      'const express = require("express")',
      "",
      "const router = express.Router()",
      "",
      'router.get("/users", (req, res) => res.json([]))',
      "",
      "router.use((req, res, next) => next())",
      "",
      "module.exports = router",
      "",
    ])

    expect(confidences).toEqual([
      "router high",
      "router__get__$users__d0 high",
      "router__use__d0 high",
    ])
  })
})
