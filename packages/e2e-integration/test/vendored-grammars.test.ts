import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { repoRoot } from "../src/packed"

/**
 * `packages/lang-typescript/wasm` is generated, gitignored and published — the one
 * artifact in this repository that is all three at once. Nothing else covers the script
 * that writes it.
 *
 * The script always writes into its own package root, so provisioning is exercised by
 * copying it into a sandbox directory and running it there. That keeps the real `wasm/`
 * untouched: sibling test files in this suite import `@aburi/lang-typescript`, whose
 * `dist/index.mjs` refuses to load without it, and vitest runs test files in parallel.
 * The sandbox sits inside the package so that `createRequire` still resolves
 * `@vscode/tree-sitter-wasm` from its `node_modules`.
 */

const GRAMMARS = ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"]

const packageRoot = join(repoRoot, "packages", "lang-typescript")
const scriptPath = join(packageRoot, "scripts", "copy-grammars.mjs")
const sandbox = join(packageRoot, `.grammar-sandbox-${process.pid}`)
const sandboxWasm = join(sandbox, "wasm")

const require = createRequire(join(packageRoot, "package.json"))
const upstream = (name: string) => require.resolve(`@vscode/tree-sitter-wasm/wasm/${name}`)

let vendorGrammars: () => Promise<void>

beforeAll(async () => {
  await mkdir(join(sandbox, "scripts"), { recursive: true })
  const sandboxScript = join(sandbox, "scripts", "copy-grammars.mjs")
  await copyFile(scriptPath, sandboxScript)
  const module = (await import(pathToFileURL(sandboxScript).href)) as {
    default: () => Promise<void>
  }
  vendorGrammars = module.default
  await vendorGrammars()
})

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

describe("e2e: grammar wasms are reproducible build output", () => {
  it("provisions both grammars and a NOTICE from an empty directory", async () => {
    expect((await readdir(sandboxWasm)).sort()).toEqual(["NOTICE", ...GRAMMARS].sort())
  })

  it("copies the grammars byte-for-byte", async () => {
    for (const name of GRAMMARS) {
      const [vendored, source] = await Promise.all([
        readFile(join(sandboxWasm, name)),
        readFile(upstream(name)),
      ])
      expect(vendored.equals(source)).toBe(true)
    }
  })

  it("names the version it actually read, not a literal", async () => {
    const { version } = require("@vscode/tree-sitter-wasm/package.json") as { version: string }
    const notice = await readFile(join(sandboxWasm, "NOTICE"), "utf8")
    expect(notice).toContain(`@vscode/tree-sitter-wasm@${version}`)
  })

  it("reproduces the upstream licence verbatim", async () => {
    const licence = await readFile(require.resolve("@vscode/tree-sitter-wasm/LICENSE"), "utf8")
    const notice = await readFile(join(sandboxWasm, "NOTICE"), "utf8")
    expect(notice).toContain(licence.trimEnd())
  })

  it("records the components upstream registers for these binaries", async () => {
    const { registrations } = require("@vscode/tree-sitter-wasm/cgmanifest.json") as {
      registrations: { component: { git: { name: string } }; version: string }[]
    }
    const notice = await readFile(join(sandboxWasm, "NOTICE"), "utf8")
    for (const entry of registrations) {
      expect(notice).toContain(`${entry.component.git.name} ${entry.version}`)
    }
  })

  it("rewrites nothing on a second run", async () => {
    const before = await Promise.all(
      ["NOTICE", ...GRAMMARS].map(async (name) => (await stat(join(sandboxWasm, name))).mtimeMs),
    )
    await vendorGrammars()
    const after = await Promise.all(
      ["NOTICE", ...GRAMMARS].map(async (name) => (await stat(join(sandboxWasm, name))).mtimeMs),
    )
    expect(after).toEqual(before)
  })
})

describe("e2e: the parser's grammar paths and the vendoring script agree", () => {
  it("resolves every grammar the parser dispatches to", async () => {
    // `src/parser.ts` names the two wasms as `new URL()` literals — they have to stay
    // literals for a bundler to treat them as assets — so the script's list is a second,
    // independent copy. This is what catches the two drifting apart.
    const parser = await readFile(join(packageRoot, "src", "parser.ts"), "utf8")
    const referenced = [...parser.matchAll(/new URL\("\.\.\/wasm\/([^"]+)"/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
    expect(referenced.sort()).toEqual([...GRAMMARS].sort())

    for (const name of referenced) {
      await expect(stat(join(packageRoot, "wasm", name))).resolves.toBeDefined()
    }
  })
})
