import { extractSymbols, parseTypescriptFile } from "@aburi/lang-typescript"
import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { hasRouteArguments } from "../src/routes"
import { makeCtx } from "./fixtures/symbol"

async function firstCallNode(source: string): Promise<unknown> {
  const parsed = await parseTypescriptFile({ path: "src/a.ts", content: source })
  if (parsed.tree === null) throw new Error("parse failed")
  const symbols = extractSymbols(
    parsed.tree,
    makeCtx("src/a.ts", source),
  ) as SymbolCandidate<unknown>[]
  const found = symbols.find((s) => s.kind === "call")
  if (found === undefined) throw new Error("no call symbol found")
  return found.fullNode
}

describe("hasRouteArguments", () => {
  it("answers for a call node", async () => {
    expect(hasRouteArguments(await firstCallNode(`app.get("/users", listUsers)\n`))).toBe(true)
    expect(hasRouteArguments(await firstCallNode(`app.get("env")\n`))).toBe(false)
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a plain object", {}],
    ["the source text of a route", `app.get("/users", listUsers)`],
  ])("answers false for %s, which is not a syntax node", (_label, value) => {
    expect(hasRouteArguments(value)).toBe(false)
  })
})
