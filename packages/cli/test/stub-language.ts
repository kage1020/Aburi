import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { GitRunner } from "../src"

/**
 * A workspace whose only language plugin is written by the test.
 *
 * Shared because it is the only way to produce a refusal or an extraction throw on demand —
 * no in-tree plugin will do either to order — and because a second copy of it would be a
 * second definition of what `bad.stub` means, kept in step by hand.
 *
 * The plugin is named by relative path, a ref form the loader supports.
 */

/**
 * A file is refused outright if its path contains `bad`, keeps a recoverable error and its
 * Symbol if it contains `warn`, makes extraction throw if it contains `boom`, and is clean
 * otherwise — so `ok.stub` is the quiet one. Which of them exist is up to the caller, so
 * a fixture can differ between the base worktree and the working tree.
 *
 * By substring rather than by exact name because discovery sorts by path, and a fixture that
 * needs two files of one behaviour, or needs a given behaviour to arrive second, has to be
 * free to name them — which a prefix rule is not enough for, since `bad` sorts before `boom`
 * whatever follows it.
 */
export const STUB_PLUGIN = `
const manifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
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
    return [
      {
        id: "stub:" + ctx.file.path + "#" + name,
        kind: "function",
        extKind: null,
        name,
        visibility: "public",
        decorators: [],
        signature: null,
        source: {
          file: ctx.file.path,
          startLine: 1,
          endLine: 2,
          startColumn: null,
          endColumn: null,
        },
        derivedBy: [],
        bodyNode: tree,
        fullNode: tree,
      },
    ]
  },
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "stub-ast",
}
`

export async function populate(dir: string, files: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    resolve(dir, "package.json"),
    JSON.stringify({ name: "scan-incidents-fixture", private: true }),
    "utf8",
  )
  await writeFile(
    resolve(dir, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.dev/schema/aburi.config.v1.json",
      languages: ["./lang-stub.mjs"],
    }),
    "utf8",
  )
  await writeFile(resolve(dir, "lang-stub.mjs"), STUB_PLUGIN, "utf8")
  for (const file of files) await writeFile(resolve(dir, file), file, "utf8")
}

/**
 * A `git` that materialises the base worktree for real, so the base scan has something to
 * scan. `makeGit`-style handlers taking no arguments cannot: the destination directory
 * arrives as `worktree add --detach <dir> <ref>`, and without creating it the base scan runs
 * against a path that does not exist.
 */
export function gitWith(baseFiles: readonly string[]): GitRunner {
  return {
    async run(args) {
      const key = args.slice(0, 2).join(" ")
      if (key === "worktree add") {
        const dir = args[3]
        if (dir === undefined) throw new Error("worktree add without a destination")
        await populate(dir, baseFiles)
      }
      if (key === "rev-parse --is-shallow-repository") return { stdout: "false\n", stderr: "" }
      return { stdout: "", stderr: "" }
    },
  }
}
