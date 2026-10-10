import { extractSymbols, parseTypescriptFile } from "@aburi/lang-typescript"
import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { extractRouterCall } from "../src/router"
import { makeCtx } from "./fixtures/symbol"

async function constSymbols(
  source: string,
  path = "src/a.ts",
): Promise<SymbolCandidate<unknown>[]> {
  const parsed = await parseTypescriptFile({ path, content: source })
  if (parsed.tree === null) throw new Error("parse failed")
  const symbols = extractSymbols(parsed.tree, makeCtx(path, source)) as SymbolCandidate<unknown>[]
  return symbols.filter((s) => s.kind === "const")
}

async function firstConstSymbol(source: string): Promise<SymbolCandidate<unknown>> {
  const [found] = await constSymbols(source)
  if (found === undefined) throw new Error("no const symbol found")
  return found
}

async function routersOf(source: string, path?: string): Promise<string[]> {
  return (await constSymbols(source, path)).map(
    (s) => `${s.name} ${extractRouterCall(s.fullNode, s.name)?.callee ?? "-"}`,
  )
}

describe("extractRouterCall", () => {
  it("recognises `Router()` as a router construction", async () => {
    const sym = await firstConstSymbol(`import { Router } from "express"\nconst r = Router()\n`)
    const call = extractRouterCall(sym.fullNode, sym.name)
    expect(call?.callee).toBe("Router")
  })

  it("recognises `express.Router()` and preserves member text", async () => {
    const sym = await firstConstSymbol(
      `import express from "express"\nconst r = express.Router()\n`,
    )
    const call = extractRouterCall(sym.fullNode, sym.name)
    expect(call?.callee).toBe("express.Router")
  })

  it("rejects `RouterFactory.build()` — leaf must be Router", async () => {
    const sym = await firstConstSymbol(`const r = RouterFactory.build()\n`)
    expect(extractRouterCall(sym.fullNode, sym.name)).toBeNull()
  })

  it("returns null when there is no call expression at all", async () => {
    const sym = await firstConstSymbol(`const r = 42\n`)
    expect(extractRouterCall(sym.fullNode, sym.name)).toBeNull()
  })

  // The initializer must BE the Router() call, not merely contain one.
  it("rejects `const r = [Router()]` (Router inside an array literal)", async () => {
    const sym = await firstConstSymbol(`import { Router } from "express"\nconst r = [Router()]\n`)
    expect(extractRouterCall(sym.fullNode, sym.name)).toBeNull()
  })

  it("rejects `const r = withLogging(Router())` (Router wrapped in another call)", async () => {
    const sym = await firstConstSymbol(
      `import { Router } from "express"\nconst r = withLogging(Router())\n`,
    )
    expect(extractRouterCall(sym.fullNode, sym.name)).toBeNull()
  })

  it("accepts `const r = (Router())` (parenthesized initializer is transparent)", async () => {
    const sym = await firstConstSymbol(`import { Router } from "express"\nconst r = (Router())\n`)
    const call = extractRouterCall(sym.fullNode, sym.name)
    expect(call?.callee).toBe("Router")
  })

  describe("a statement declaring several names", () => {
    it("reads a Router first in the statement as that name's alone", async () => {
      const routers = await routersOf(
        `import express from "express"\nexport const router = express.Router(), API_PREFIX = "/api/v1", MAX_BODY = 1024\n`,
      )
      expect(routers.sort()).toEqual(["API_PREFIX -", "MAX_BODY -", "router express.Router"])
    })

    it("reads a Router declared second", async () => {
      const routers = await routersOf(
        `import express from "express"\nexport const limit = 10, adminRouter = express.Router()\n`,
      )
      expect(routers.sort()).toEqual(["adminRouter express.Router", "limit -"])
    })

    it("reads the CommonJS `var express = require('express'), router = express.Router()`", async () => {
      const routers = await routersOf(
        `var express = require('express'),\n    router = express.Router();\n\nmodule.exports = router;\n`,
        "routes/users.js",
      )
      expect(routers.sort()).toEqual(["express -", "router express.Router"])
    })

    it("finds the declarator of a name qualified by its namespace", async () => {
      const routers = await routersOf(
        `import { Router } from "express"\nnamespace api {\n  export const version = 1, router = Router()\n}\n`,
      )
      expect(routers.sort()).toEqual(["api.router Router", "api.version -"])
    })

    it("reads a declarator with no initializer as no Router, and the Router after it", async () => {
      const routers = await routersOf(`import { Router } from "express"\nlet a, r = Router()\n`)
      expect(routers.sort()).toEqual(["a -", "r Router"])
    })

    it("reads each Router's callee from its own declarator", async () => {
      const routers = await routersOf(
        `import express, { Router } from "express"\nconst a = Router(), b = express.Router()\n`,
      )
      expect(routers.sort()).toEqual(["a Router", "b express.Router"])
    })
  })

  describe("a name destructured from a Router call", () => {
    it("does not read a name an object pattern pulls out as a Router", async () => {
      const routers = await routersOf(
        `import { Router } from "express"\nconst { stack } = Router()\n`,
      )
      expect(routers).toEqual(["stack -"])
    })

    it("does not read a name an array pattern pulls out as a Router", async () => {
      const routers = await routersOf(
        `import { Router } from "express"\nconst [first] = Router()\n`,
      )
      expect(routers).toEqual(["first -"])
    })

    it("does not read it as a Router beside a Router declared in the same statement", async () => {
      const routers = await routersOf(
        `import { Router } from "express"\nconst { stack } = Router(), router = Router()\n`,
      )
      expect(routers.sort()).toEqual(["router Router", "stack -"])
    })
  })
})
