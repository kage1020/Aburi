import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { GitRunner } from "../src"
import { fakeGit } from "./fixtures"

export const STUB_PLUGIN = `
const manifest = {
  $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
  name: "lang-stub",
  version: "0.0.0",
  type: "lang",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [],
    frameworks: [],
  },
}

export const plugin = {
  manifest,
  languageId: "stub",
  fileExtensions: [".stub"],
  capabilities: {
    hasDecorators: false,
    hasGenerics: false,
    hasAsync: false,
    hasMacros: false,
    hasPatternMatching: false,
    hasAbstractTypes: false,
    hasModules: false,
    hasNamespaces: false,
    hasTypeParameters: false,
    hasExplicitVisibility: false,
    hasJsDoc: false,
  },
  init: async () => {},
  parseFile: async (file) => {
    const tree = { path: file.path }
    if (file.path.includes("bad")) {
      return {
        tree,
        errors: [{ message: "unterminated string", line: 12, column: 4, recoverable: false }],
        imports: [],
      }
    }
    if (file.path.includes("noisy")) {
      return {
        tree,
        errors: [
          { message: "stray token", line: 2, column: 1, recoverable: true },
          { message: "stray token", line: 9, column: 7, recoverable: true },
        ],
        imports: [],
      }
    }
    if (file.path.includes("warn")) {
      return {
        tree,
        errors: [{ message: "stray token", line: 2, column: 1, recoverable: true }],
        imports: [],
      }
    }
    return { tree, errors: [], imports: [] }
  },
  extractSymbols: (tree, ctx) => {
    if (ctx.file.path.includes("boom")) throw new Error("plugin exploded")
    const name = ctx.file.path.replace(/[^A-Za-z0-9]/g, "_")
    const at = (startLine) => ({
      id: "stub:" + ctx.file.path + "#" + name,
      kind: "function",
      extKind: ctx.file.path.includes("odd") ? "stub:odd:thing" : null,
      name,
      visibility: "public",
      decorators: [],
      signature: null,
      source: {
        file: ctx.file.path,
        startLine,
        endLine: startLine + 1,
        startColumn: null,
        endColumn: null,
      },
      derivedBy: [],
      bodyNode: tree,
      fullNode: tree,
    })
    return ctx.file.path.includes("twin") ? [at(1), at(7)] : [at(1)]
  },
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "stub-ast",
}
`

export async function populate(
  dir: string,
  files: readonly string[],
  config: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    resolve(dir, "package.json"),
    JSON.stringify({ name: "scan-incidents-fixture", private: true }),
    "utf8",
  )
  await writeFile(
    resolve(dir, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["./lang-stub.mjs"],
      ...config,
    }),
    "utf8",
  )
  await writeFile(resolve(dir, "lang-stub.mjs"), STUB_PLUGIN, "utf8")
  for (const file of files) await writeFile(resolve(dir, file), file, "utf8")
}

export function gitWith(baseFiles: readonly string[]): GitRunner {
  return fakeGit({ onWorktreeAdd: (dir) => populate(dir, baseFiles) }).runner
}
