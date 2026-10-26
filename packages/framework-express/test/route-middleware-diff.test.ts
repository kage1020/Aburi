import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import type { DiffResult, SymbolChanged } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { expressFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("route-middleware")

const SOURCE = "src/routes.ts"

const lineup = { languages: [langTypescriptPlugin], frameworks: [expressFrameworkPlugin] }

const routes = (registration: string) =>
  [
    'import { Router } from "express"',
    'import { audit, requireAdmin } from "./middleware"',
    "export const router = Router()",
    registration,
    "",
  ].join("\n")

const usersRoute = (...middleware: string[]) =>
  routes(
    `router.get("/users", ${[...middleware, "async (_req, res) => {\n  res.json([])\n}"].join(", ")})`,
  )

function onlyChange(diff: DiffResult): SymbolChanged {
  expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
  const [change] = diff.symbols
  if (change?.status !== "changed") throw new Error(`expected one change, got ${change?.status}`)
  return change
}

describe("diff — a route's middleware", () => {
  it.each([
    ["removed", ["requireAdmin"], [], { added: [], removed: ["requireAdmin"], reordered: false }],
    ["added", [], ["requireAdmin"], { added: ["requireAdmin"], removed: [], reordered: false }],
    [
      "reordered",
      ["requireAdmin", "audit"],
      ["audit", "requireAdmin"],
      { added: [], removed: [], reordered: true },
    ],
    [
      "swapped for another",
      ["requireAdmin"],
      ["audit"],
      { added: ["audit"], removed: ["requireAdmin"], reordered: false },
    ],
  ])("is a logic change when one is %s", async (_edit, before, after, middleware) => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      usersRoute(...before),
      usersRoute(...after),
    )

    const change = onlyChange(diff)
    expect(change.after.id).toBe("ts:src/routes.ts#router__get__$users__d0")
    expect(change.delta).toMatchObject({ logicChanged: true, middleware })
  })

  it("reports the middleware as unchanged when only the handler's body moved", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      routes(`router.get("/users", requireAdmin, async (_req, res) => {\n  res.json([])\n})`),
      routes(`router.get("/users", requireAdmin, async (_req, res) => {\n  res.json([1])\n})`),
    )

    expect(onlyChange(diff).delta.middleware).toEqual({ added: [], removed: [], reordered: false })
  })

  it("leaves the middleware out of a route that names none on either side", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      routes(`router.get("/users", async (_req, res) => {\n  res.json([])\n})`),
      routes(`router.get("/users", async (_req, res) => {\n  res.json([1])\n})`),
    )

    expect(onlyChange(diff).delta).not.toHaveProperty("middleware")
  })

  it("is no change when the middleware is only rewrapped and commented", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      usersRoute("requireAdmin", "audit"),
      usersRoute("requireAdmin /* gate */", "\n  audit"),
    )

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 0, unchanged: 2 })
  })
})
