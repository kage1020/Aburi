import { extractSymbols, parseTypescriptFile } from "@aburi/lang-typescript"
import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { analyzeUseArguments } from "../src/middleware"
import { makeCtx } from "./fixtures/symbol"

async function firstCallSymbol(source: string): Promise<SymbolCandidate<unknown>> {
  const parsed = await parseTypescriptFile({ path: "src/a.ts", content: source })
  if (parsed.tree === null) throw new Error("parse failed")
  const symbols = extractSymbols(
    parsed.tree,
    makeCtx("src/a.ts", source),
  ) as SymbolCandidate<unknown>[]
  const found = symbols.find((s) => s.kind === "call")
  if (found === undefined) throw new Error("no call symbol found")
  return found
}

describe("analyzeUseArguments", () => {
  it("detects arity-3 arrow handler as regular middleware", async () => {
    const sym = await firstCallSymbol(
      `import express from "express"\nconst app = express()\napp.use((req, res, next) => next())\n`,
    )
    const shape = analyzeUseArguments(sym.fullNode)
    expect(shape?.hasRegularHandler).toBe(true)
    expect(shape?.hasErrorHandler).toBe(false)
    expect(shape?.hasIdentifierArg).toBe(false)
  })

  it("detects arity-4 arrow handler as error middleware", async () => {
    const sym = await firstCallSymbol(
      `import express from "express"\nconst app = express()\napp.use((err, req, res, next) => next(err))\n`,
    )
    const shape = analyzeUseArguments(sym.fullNode)
    expect(shape?.hasErrorHandler).toBe(true)
    expect(shape?.hasRegularHandler).toBe(false)
  })

  it("detects arity-4 function_expression handler as error middleware", async () => {
    const sym = await firstCallSymbol(
      `import express from "express"\nconst app = express()\napp.use(function (err, req, res, next) { return next(err) })\n`,
    )
    const shape = analyzeUseArguments(sym.fullNode)
    expect(shape?.hasErrorHandler).toBe(true)
  })

  it("flags mount-point shape: (pathLiteral, identifier)", async () => {
    const sym = await firstCallSymbol(
      `import express from "express"\nconst app = express()\napp.use('/api', router)\n`,
    )
    const shape = analyzeUseArguments(sym.fullNode)
    expect(shape?.firstArgIsPathLiteral).toBe(true)
    expect(shape?.secondArgIsIdentifier).toBe(true)
    expect(shape?.argCount).toBe(2)
    expect(shape?.hasRegularHandler).toBe(false)
    expect(shape?.hasErrorHandler).toBe(false)
  })

  it("flags identifier-arg middleware without asserting arity", async () => {
    const sym = await firstCallSymbol(
      `import express from "express"\nconst app = express()\napp.use(logger)\n`,
    )
    const shape = analyzeUseArguments(sym.fullNode)
    expect(shape?.hasIdentifierArg).toBe(true)
    expect(shape?.hasRegularHandler).toBe(false)
  })
})
