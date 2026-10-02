import { expressFrameworkPlugin } from "@aburi/framework-express"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * Inserting one registration above others is one addition. A registration with no quoted path
 * used to be named by its source-order ordinal alone, so the insertion renamed every later one
 * and the diff paired each with the body its id used to hold: adding `compression()` reported
 * the authorization guard as removed (lang-plugin.md LP20i1, issue #344).
 */

const workspace = useScratchWorkspace("registration-insert")

async function scanOf(source: string): Promise<IR> {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("src/server.ts", source)
  const { ir } = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [expressFrameworkPlugin],
  })
  return ir
}

async function diffOfEdit(before: string, after: string) {
  const baseIR = await scanOf(before)
  const headIR = await scanOf(after)
  return diffIRs(baseIR, headIR)
}

const AUTH = [
  "app.use((req, res, next) => {",
  "  if (!req.headers.authorization) return res.status(401).end()",
  "  next()",
  "})",
]

describe("diff — a registration inserted above others", () => {
  it("is one addition for middleware with no path", async () => {
    const head = ['import express from "express"', "const app = express()"]
    const diff = await diffOfEdit(
      [...head, "app.use(cors())", "app.use(helmet())", ...AUTH, ""].join("\n"),
      [...head, "app.use(compression())", "app.use(cors())", "app.use(helmet())", ...AUTH, ""].join(
        "\n",
      ),
    )

    expect(diff.summary.added).toBe(1)
    expect(diff.summary.removed).toBe(0)
    expect(diff.summary.changed).toBe(0)
    expect(diff.symbols.filter((s) => s.status === "added").map((s) => s.symbol.id)).toEqual([
      "ts:src/server.ts#app__use__compression__d0",
    ])
  })

  it("is one addition for routes whose paths are written in backticks", async () => {
    const head = ['import express from "express"', "const app = express()"]
    const users = "app.get(`/users`, async (req, res) => { res.json(await listUsers()) })"
    const admin =
      "app.get(`/admin`, async (req, res) => { await requireAdmin(req); res.json(await stats()) })"
    const diff = await diffOfEdit(
      [...head, users, admin, ""].join("\n"),
      [...head, 'app.get(`/health`, (req, res) => { res.send("ok") })', users, admin, ""].join(
        "\n",
      ),
    )

    expect(diff.summary.added).toBe(1)
    expect(diff.summary.removed).toBe(0)
    expect(diff.summary.changed).toBe(0)
    expect(diff.symbols.filter((s) => s.status === "added").map((s) => s.symbol.id)).toEqual([
      "ts:src/server.ts#app__get__$health__d0",
    ])
  })
})
