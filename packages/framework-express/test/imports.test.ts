import { parseTypescriptFile } from "@aburi/lang-typescript"
import type { FrameworkClassifyContext, ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { hasExpressImport, importListMentionsExpress, readExpressFromText } from "../src/imports"
import { makeCtx } from "./fixtures/symbol"

/**
 * The context the scan hands a framework plugin: the file and its parsed import edges. The
 * scan also puts each edge through NFC first, which leaves an ASCII specifier's edge as it
 * is; the e2e scan in `e2e-integration` goes through that step.
 */
async function classifyCtx(source: string): Promise<FrameworkClassifyContext> {
  const parsed = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return { ...makeCtx("src/a.ts", source), imports: parsed.imports }
}

async function importsExpress(source: string): Promise<boolean> {
  return hasExpressImport(await classifyCtx(source))
}

const CONFLICTED = [
  "<<<<<<< HEAD",
  'import express from "express"',
  "=======",
  'import express, { Router } from "express"',
  ">>>>>>> feature",
  "const app = express()",
].join("\n")

describe("hasExpressImport", () => {
  it.each([
    ["a default import", `import express from "express"\n`],
    ["a named import", `import { Router } from 'express'\nconst r = Router()`],
    ["a namespace import", `import * as express from "express"\n`],
    [
      "a named import wrapped over several lines",
      `import {\n  Router,\n  type NextFunction,\n  type Request,\n  type Response,\n} from "express"\n`,
    ],
    ["a type-only import", `import type { Request, Response } from "express"\n`],
    ["a subpath", `import { Router } from "express/lib/router"\n`],
    ["a side-effect import", `import "express"\n`],
    ["a dynamic import", `const express = await import("express")\n`],
    ["a re-export", `export { Router } from "express"\n`],
    ["a re-export of everything", `export * from "express"\n`],
    ["TypeScript's import-require", `import express = require("express")\n`],
    ["CommonJS require", `const express = require("express")`],
    ["CommonJS require beside a comment", `// app\nconst express = require('express') // server\n`],
    ["CommonJS require of a subpath", `const { Router } = require("express/lib/router")\n`],
    ["CommonJS require in backticks", "const express = require(`express`)\n"],
  ])("reads %s as Express", async (_label, source) => {
    expect(await importsExpress(source)).toBe(true)
  })

  // Each of these has no `express` edge, so only the text can answer.
  it.each([
    ["an import between merge-conflict markers", CONFLICTED],
    ["an import followed by two junk tokens", `import express from "express" foo bar\n`],
    ["an import followed by a stray bracket", `import express from "express"]\n`],
    [
      "an import broken that way below another import, which keeps its edge",
      `import fs from "fs"\nimport express from "express" foo bar\n`,
    ],
    ["an import inside `declare module`", `declare module "x" { import express from "express" }\n`],
    ["an import inside a namespace", `namespace api { import express from "express" }\n`],
  ])("reads %s as Express", async (_label, source) => {
    const ctx = await classifyCtx(source)
    expect(importListMentionsExpress(ctx.imports)).toBe(false)
    expect(hasExpressImport(ctx)).toBe(true)
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
    ["a require quoted in a string", `const snippet = "const e = require('express')"\n`],
    ["an import quoted in a string", `const snippet = 'import express from "express"'\n`],
    ["a require written in a template", "const doc = `run require('express') first`\n"],
  ])("does not read %s as Express", async (_label, source) => {
    expect(await importsExpress(source)).toBe(false)
  })

  it("reads an import from its edge where the text reading loses it", async () => {
    // The quote in the JSX text hides the rest of the line from the tokenizer (see
    // `tokenize`); the parser still reads the import, and the edge is what answers.
    const source = `const A = () => <p>Don't</p>; import express from "express"\n`
    const parsed = await parseTypescriptFile({ path: "src/a.tsx", content: source })
    const ctx = { ...makeCtx("src/a.tsx", source), imports: parsed.imports }
    expect(readExpressFromText(source).imports).toBe(false)
    expect(hasExpressImport(ctx)).toBe(true)
  })

  it("answers each file from its own text when two contexts share one import list", () => {
    // The text reading is cached on the import list; a list shared across files must not
    // hand one file's answer to the other.
    const imports: ImportEdge[] = []
    const app = { ...makeCtx("src/app.js", `const express = require("express")\n`), imports }
    const other = { ...makeCtx("src/other.js", `const x = 1\n`), imports }
    expect(hasExpressImport(app)).toBe(true)
    expect(hasExpressImport(other)).toBe(false)
  })
})

describe("readExpressFromText — the require call", () => {
  it.each([
    ["a `//` inside a string", `const u = "http://x"; const e = require("express")`],
    [
      "a template literal holding a comment marker",
      "const t = `/* x */`\nconst e = require('express')",
    ],
    ["an escaped quote inside a string", `const s = "a\\"b // c"; const e = require("express")`],
    [
      "a regex literal whose class holds `/` and `*`",
      `const re = /[/*]/\nconst e = require("express")`,
    ],
    [
      "a regex literal whose class holds `/` and a quote",
      `const re = /[/']/; const e = require("express")`,
    ],
    ["a regex literal holding an escaped `/`", `const re = /a\\/'/; const e = require("express")`],
    [
      "a nested template inside a substitution",
      `const u = \`\${\`//cdn\`}\`; const e = require("express")`,
    ],
    [
      "braces and a backtick string inside a substitution",
      `const t = \`\${ {}.x + "\`" }\`; const e = require("express")`,
    ],
    [
      "an escaped backtick inside a template",
      "const t = `a\\`b // c`; const e = require('express')",
    ],
    ["a division", `const r = a / b; const e = require("express"); const s = c / d`],
    [
      "a division after a call",
      `const r = f(x) / 2; const e = require("express"); const s = c / d`,
    ],
    [
      "a division after a property named like a keyword",
      `const r = res.delete / 2; const e = require("express"); const s = c / d`,
    ],
    [
      "a division after a postfix increment",
      `const r = i++ / 2; const e = require("express"); const s = c / d`,
    ],
    [
      "a division after a non-null assertion",
      `const r = a! / 2; const e = require("express"); const s = c / d`,
    ],
    ["a regex literal after an `if (…)` head", `if (ok) /'/.test(s); const e = require("express")`],
    ["a regex literal after a block", `function f() {}\n/'/.test(s); const e = require("express")`],
    [
      "a regex literal after `return`",
      `function f(s) { return /'/.test(s) }; const e = require("express")`,
    ],
    [
      "a JSX closing tag, a `/` with no closing `/` on its line",
      `const A = <p>x</p>; const e = require("express")\n`,
    ],
  ])("finds a require after %s", (_label, source) => {
    expect(readExpressFromText(source).requires).toBe(true)
  })

  it.each([
    [
      "a regex literal holding a quote before a line comment",
      `const re = /'/ // const e = require("express")`,
    ],
    [
      "a block comment left open to the end of the file",
      `const a = 1 /* unterminated\nconst e = require("express")\n`,
    ],
    ["`express-session`", `const s = require("express-session")`],
    ["a specifier built by concatenation", `const s = require("express" + "-session")`],
  ])("finds no require in %s", (_label, source) => {
    expect(readExpressFromText(source).requires).toBe(false)
  })

  // JSX text cannot be told apart from code without a parser (see `tokenize`). These pin the
  // two ways that reads wrong, so a change to either shows up here.
  it("reads a `require` commented out after JSX text with a quote as code", () => {
    const source = `const A = () => <p>Don't</p> /* old:\nconst e = require("express")\n*/\n`
    expect(readExpressFromText(source).requires).toBe(true)
  })

  it("loses a `require` written after JSX text with a quote on the same line", () => {
    const source = `const A = <p>Don't</p>; const e = require("express")\n`
    expect(readExpressFromText(source).requires).toBe(false)
  })
})

describe("readExpressFromText — the import statement", () => {
  it.each([
    [
      "a named import wrapped over several lines",
      `import {\n  Router,\n  Request,\n} from "express"`,
    ],
    ["a side-effect import", `import "express"`],
    ["a dynamic import in backticks", "const e = await import(`express`)"],
    ["a re-export", `export * from "express"`],
    ["a subpath", `import { Router } from "express/lib/router"`],
  ])("finds %s", (_label, source) => {
    expect(readExpressFromText(source).imports).toBe(true)
  })

  it.each([
    ["an import of another package", `import fs from "fs"; const name = "express"`],
    ["`express` as a later string, not the specifier", `export const pkg = "express"`],
    ["an object with `import` and `from` keys", `const o = { import: 1, from: "express" }`],
    ["`import.meta`", `const url = import.meta.resolve("express")`],
    ["a method named `import`", `const mod = loader.import("express")`],
    ["a commented-out import", `// import express from "express"`],
  ])("finds nothing in %s", (_label, source) => {
    expect(readExpressFromText(source).imports).toBe(false)
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

  it("matches an ImportEdge to an 'express/' subpath", () => {
    expect(
      importListMentionsExpress([
        { source: "express/lib/router", symbols: ["Router"], line: 1, dynamic: false },
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
