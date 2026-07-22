import { describe, expect, it } from "vitest"
import { hasExpressImport, importListMentionsExpress } from "../src/imports"
import { makeCtx } from "./fixtures/symbol"

describe("hasExpressImport (source scan)", () => {
  it("matches `import express from 'express'`", () => {
    expect(hasExpressImport(makeCtx("src/a.ts", `import express from "express"\n`))).toBe(true)
  })

  it("matches `import { Router } from 'express'`", () => {
    expect(
      hasExpressImport(makeCtx("src/a.ts", `import { Router } from 'express'\nconst r = Router()`)),
    ).toBe(true)
  })

  it("matches CommonJS `require('express')`", () => {
    expect(hasExpressImport(makeCtx("src/a.ts", `const express = require("express")`))).toBe(true)
  })

  it("returns false when express is not imported", () => {
    expect(hasExpressImport(makeCtx("src/a.ts", `import fs from "fs"\n`))).toBe(false)
  })

  it("does not confuse `express-session` for `express`", () => {
    expect(hasExpressImport(makeCtx("src/a.ts", `import session from "express-session"\n`))).toBe(
      false,
    )
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
