import { parseTypescriptFile } from "@aburi/lang-typescript"
import type { FrameworkClassifyContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { hasExpressImport, importListMentionsExpress, requiresExpress } from "../src/imports"
import { makeCtx } from "./fixtures/symbol"

/** The context the scan hands a framework plugin: the file and its parsed import edges. */
async function classifyCtx(source: string): Promise<FrameworkClassifyContext> {
  const parsed = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return { ...makeCtx("src/a.ts", source), imports: parsed.imports }
}

async function importsExpress(source: string): Promise<boolean> {
  return hasExpressImport(await classifyCtx(source))
}

describe("hasExpressImport", () => {
  it.each([
    ["a default import", `import express from "express"\n`],
    ["a named import", `import { Router } from 'express'\nconst r = Router()`],
    ["a namespace import", `import * as express from "express"\n`],
    [
      "a named import wrapped over several lines",
      `import {\n  Router,\n  type NextFunction,\n  type Request,\n  type Response,\n} from "express"\n`,
    ],
    ["a subpath", `import { Router } from "express/lib/router"\n`],
    ["a side-effect import", `import "express"\n`],
    ["a dynamic import", `const express = await import("express")\n`],
    ["a re-export", `export { Router } from "express"\n`],
    ["CommonJS require", `const express = require("express")`],
    ["CommonJS require beside a comment", `// app\nconst express = require('express') // server\n`],
  ])("reads %s as Express", async (_label, source) => {
    expect(await importsExpress(source)).toBe(true)
  })

  it.each([
    ["no express at all", `import fs from "fs"\n`],
    ["express-session", `import session from "express-session"\n`],
    [
      "a commented-out import",
      `// was: import express from "express"\nimport { Hono } from "hono"\n`,
    ],
    [
      "a commented-out require",
      `/* const express = require("express") */\nconst app = createApp()\n`,
    ],
    ["a line-commented require", `// const express = require("express")\n`],
  ])("does not read %s as Express", async (_label, source) => {
    expect(await importsExpress(source)).toBe(false)
  })
})

describe("requiresExpress", () => {
  it("does not mistake `//` inside a string for a comment", () => {
    expect(requiresExpress(`const u = "http://x"; const e = require("express")`)).toBe(true)
  })

  it("steps over a template literal holding a comment marker", () => {
    expect(requiresExpress("const t = `/* x */`\nconst e = require('express')")).toBe(true)
  })

  it("ends a quote string at its line, so a quote in a regex literal costs one line", () => {
    expect(requiresExpress(`const re = /'/\n// const e = require("express")`)).toBe(false)
  })

  it("does not read `require('express-session')` as Express", () => {
    expect(requiresExpress(`const s = require("express-session")`)).toBe(false)
  })
})

describe("importListMentionsExpress", () => {
  it("matches an ImportEdge whose source is exactly 'express'", () => {
    expect(
      importListMentionsExpress([
        { source: "express", symbols: ["default"], line: 1, dynamic: false },
      ]),
    ).toBe(true)
  })

  it("does not match 'express-session'", () => {
    expect(
      importListMentionsExpress([
        { source: "express-session", symbols: ["default"], line: 1, dynamic: false },
      ]),
    ).toBe(false)
  })
})
