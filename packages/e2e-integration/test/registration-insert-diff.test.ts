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
 * the authorization guard as removed (lang-plugin.md LP20i1).
 *
 * This runs the real pipeline over each edit: write the one source file, scan, rewrite that
 * file, scan again, diff.
 */

const workspace = useScratchWorkspace("registration-insert")

const SOURCE = "src/server.ts"

async function scanSource(): Promise<IR> {
  const { ir } = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [expressFrameworkPlugin],
  })
  return ir
}

/** Scan `before`, rewrite the one source file to `after`, scan again, diff the two. */
async function diffOfEdit(before: string, after: string) {
  await workspace.writeSource(SOURCE, before)
  const baseIR = await scanSource()
  await workspace.writeSource(SOURCE, after)
  const headIR = await scanSource()
  return { baseIR, headIR, diff: diffIRs(baseIR, headIR) }
}

const lines = (...rows: string[]) => [...rows, ""].join("\n")

const HEAD = ['import express from "express"', "const app = express()"]

const AUTH = [
  "app.use((req, res, next) => {",
  "  if (!req.headers.authorization) return res.status(401).end()",
  "  next()",
  "})",
]

/** The ids the diff reports `added`, or `removed`: the two statuses that carry one `symbol`. */
function idsWith(diff: ReturnType<typeof diffIRs>, status: "added" | "removed"): string[] {
  const ids: string[] = []
  for (const change of diff.symbols) {
    if (change.status !== status) continue
    if (change.status === "added" || change.status === "removed") ids.push(change.symbol.id)
  }
  return ids
}

describe("diff — a registration inserted above others", () => {
  it("is one addition for middleware with no path", async () => {
    const { diff } = await diffOfEdit(
      lines(...HEAD, "app.use(cors())", "app.use(helmet())", ...AUTH),
      lines(...HEAD, "app.use(compression())", "app.use(cors())", "app.use(helmet())", ...AUTH),
    )

    expect(diff.summary).toMatchObject({ added: 1, removed: 0, changed: 0, moved: 0 })
    expect(idsWith(diff, "added")).toEqual(["ts:src/server.ts#app__use__compression__d0"])
  })

  it("is one addition for routes whose paths are written in backticks", async () => {
    const users = "app.get(`/users`, async (req, res) => { res.json(await listUsers()) })"
    const admin =
      "app.get(`/admin`, async (req, res) => { await requireAdmin(req); res.json(await stats()) })"
    const mount = "app.use(`/api`, apiRouter)"
    const { headIR, diff } = await diffOfEdit(
      lines(...HEAD, users, admin, mount),
      lines(...HEAD, 'app.get(`/health`, (req, res) => { res.send("ok") })', users, admin, mount),
    )

    expect(diff.summary).toMatchObject({ added: 1, removed: 0, changed: 0, moved: 0 })
    expect(idsWith(diff, "added")).toEqual(["ts:src/server.ts#app__get__$health__d0"])

    // The id is named by the path, and the Express plugin has to read the same path: a
    // backtick it declined made the mount below a `middleware` whose id says `$api`.
    const extKindOf = (id: string) => headIR.symbols.find((s) => s.id === id)?.extKind
    expect(extKindOf("ts:src/server.ts#app__get__$users__d0")).toBe("framework:express:route")
    expect(extKindOf("ts:src/server.ts#app__use__$api__d0")).toBe("framework:express:mount")
  })

  it("is one addition for routes mounted through app.route with one handler name", async () => {
    // Named by the leaf call alone, the three were `app__get__h`, told apart by order.
    const a = "app.route('/a').get(async (req, res) => { res.json(await listA()) })"
    const b =
      "app.route('/b').get(async (req, res) => { await audit(req); res.json(await listB()) })"
    const { headIR, diff } = await diffOfEdit(
      lines(...HEAD, a, b),
      lines(...HEAD, "app.route('/health').get((req, res) => { res.send('ok') })", a, b),
    )

    expect(diff.summary).toMatchObject({ added: 1, removed: 0, changed: 0, moved: 0 })
    expect(idsWith(diff, "added")).toEqual(["ts:src/server.ts#app__get__$health__d0"])
    // Both sides are scanned with the same plugin, so the diff alone cannot see the chain stop
    // being read as a route; the kind has to be asserted on its own.
    const extKindOf = (id: string) => headIR.symbols.find((s) => s.id === id)?.extKind
    expect(extKindOf("ts:src/server.ts#app__get__$health__d0")).toBe("framework:express:route")
  })
})

describe("diff — a registration with no path gains an argument", () => {
  it("reports it removed and added, and leaves the inline middleware below it alone", async () => {
    // The names its arguments carry are the registration's name, so `authMw` gaining `audit`
    // renames it (LP20i1 records the trade). What must not happen is the pairing this naming
    // removed: the inline guard below keeps its id and its body, and is not reported at all.
    const { diff } = await diffOfEdit(
      lines(...HEAD, "app.use(authMw)", ...AUTH),
      lines(...HEAD, "app.use(authMw, audit)", ...AUTH),
    )

    expect(diff.summary).toMatchObject({ added: 1, removed: 1, changed: 0, moved: 0 })
    expect(idsWith(diff, "removed")).toEqual(["ts:src/server.ts#app__use__authMw__d0"])
    expect(idsWith(diff, "added")).toEqual(["ts:src/server.ts#app__use__authMw$audit__d0"])
  })
})
