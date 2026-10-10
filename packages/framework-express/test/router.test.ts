import { CoreError } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { extractFile } from "@aburi/test-harness"
import { describe, expect, it } from "vitest"
import { extractRouterCall } from "../src/router"

/** `"<name> <Router callee or ->"` for each const Symbol `source` declares. */
async function routersOf(source: string, path = "src/a.ts"): Promise<string[]> {
  const { candidates } = await extractFile(langTypescriptPlugin, path, source)
  return candidates
    .filter((candidate) => candidate.kind === "const")
    .map((c) => `${c.name} ${extractRouterCall(c.fullNode, c.name)?.callee ?? "-"}`)
    .sort()
}

describe("extractRouterCall", () => {
  it.each([
    ["`Router()`", `import { Router } from "express"\nconst r = Router()\n`, ["r Router"]],
    [
      "`express.Router()`, keeping the member text",
      `import express from "express"\nconst r = express.Router()\n`,
      ["r express.Router"],
    ],
    [
      "a parenthesized `Router()`",
      `import { Router } from "express"\nconst r = (Router())\n`,
      ["r Router"],
    ],
  ])("reads %s as a Router construction", async (_label, source, routers) => {
    expect(await routersOf(source)).toEqual(routers)
  })

  it.each([
    ["a call whose leaf is not Router", `const r = RouterFactory.build()\n`],
    ["no call at all", `const r = 42\n`],
    [
      "`Router()` inside an array literal",
      `import { Router } from "express"\nconst r = [Router()]\n`,
    ],
    [
      "`Router()` wrapped in another call",
      `import { Router } from "express"\nconst r = withLogging(Router())\n`,
    ],
  ])("reads no Router from %s", async (_label, source) => {
    expect(await routersOf(source)).toEqual(["r -"])
  })

  it("lets a qualified name with an empty last segment throw rather than read no Router", async () => {
    const { candidates } = await extractFile(
      langTypescriptPlugin,
      "src/a.ts",
      `import { Router } from "express"\nconst r = Router()\n`,
    )
    const [router] = candidates

    expect(() => extractRouterCall(router?.fullNode, "api.")).toThrow(CoreError)
  })

  describe("a statement declaring several names", () => {
    it.each([
      [
        "a Router first in the statement",
        `import express from "express"\nexport const router = express.Router(), API_PREFIX = "/api/v1", MAX_BODY = 1024\n`,
        ["API_PREFIX -", "MAX_BODY -", "router express.Router"],
      ],
      [
        "a Router declared second",
        `import express from "express"\nexport const limit = 10, adminRouter = express.Router()\n`,
        ["adminRouter express.Router", "limit -"],
      ],
      [
        "a declarator with no initializer before the Router",
        `import { Router } from "express"\nlet a, r = Router()\n`,
        ["a -", "r Router"],
      ],
      [
        "two Routers, each with its own callee",
        `import express, { Router } from "express"\nconst a = Router(), b = express.Router()\n`,
        ["a Router", "b express.Router"],
      ],
      [
        "names qualified by their namespace",
        `import { Router } from "express"\nnamespace api {\n  export const version = 1, router = Router()\n}\n`,
        ["api.router Router", "api.version -"],
      ],
    ])("reads %s as that name's alone", async (_label, source, routers) => {
      expect(await routersOf(source)).toEqual(routers)
    })

    it("reads the CommonJS `var express = require('express'), router = express.Router()`", async () => {
      expect(
        await routersOf(
          `var express = require('express'),\n    router = express.Router();\n\nmodule.exports = router;\n`,
          "routes/users.js",
        ),
      ).toEqual(["express -", "router express.Router"])
    })
  })

  describe("a name destructured from a Router call", () => {
    it.each([
      ["an object pattern", `const { stack } = Router()\n`, ["stack -"]],
      ["an array pattern", `const [first] = Router()\n`, ["first -"]],
      [
        "a pattern beside a Router declared in the same statement",
        `const { stack } = Router(), router = Router()\n`,
        ["router Router", "stack -"],
      ],
    ])("is not a Router when %s pulls it out", async (_label, declaration, routers) => {
      expect(await routersOf(`import { Router } from "express"\n${declaration}`)).toEqual(routers)
    })
  })
})
