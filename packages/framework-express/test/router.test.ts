import { extractSymbols, parseTypescriptFile } from "@aburi/lang-typescript"
import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { extractRouterCall } from "../src/router"
import { makeCtx } from "./fixtures/symbol"

async function firstConstSymbol(source: string): Promise<SymbolCandidate<unknown>> {
  const parsed = await parseTypescriptFile({ path: "src/a.ts", content: source })
  if (parsed.tree === null) throw new Error("parse failed")
  const symbols = extractSymbols(
    parsed.tree,
    makeCtx("src/a.ts", source),
  ) as SymbolCandidate<unknown>[]
  const found = symbols.find((s) => s.kind === "const")
  if (found === undefined) throw new Error("no const symbol found")
  return found
}

describe("extractRouterCall", () => {
  it("recognises `Router()` as a router construction", async () => {
    const sym = await firstConstSymbol(`import { Router } from "express"\nconst r = Router()\n`)
    const call = extractRouterCall(sym.fullNode)
    expect(call?.leaf).toBe("Router")
    expect(call?.callee).toBe("Router")
  })

  it("recognises `express.Router()` and preserves member text", async () => {
    const sym = await firstConstSymbol(
      `import express from "express"\nconst r = express.Router()\n`,
    )
    const call = extractRouterCall(sym.fullNode)
    expect(call?.leaf).toBe("Router")
    expect(call?.callee).toBe("express.Router")
  })

  it("rejects `RouterFactory.build()` — leaf must be Router", async () => {
    const sym = await firstConstSymbol(`const r = RouterFactory.build()\n`)
    expect(extractRouterCall(sym.fullNode)).toBeNull()
  })

  it("returns null when there is no call expression at all", async () => {
    const sym = await firstConstSymbol(`const r = 42\n`)
    expect(extractRouterCall(sym.fullNode)).toBeNull()
  })
})
