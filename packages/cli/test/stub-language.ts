import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { GitRunner } from "../src"
import { fakeGit } from "./fixtures"

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
 * Symbol if it contains `warn`, makes extraction throw if it contains `boom`, emits two
 * Symbols under one id if it contains `twin`, and is clean otherwise — so `ok.stub` is the
 * quiet one. Which of them exist is up to the caller, so a fixture can differ between the
 * base worktree and the working tree.
 *
 * `twin` and `boom` are the two ways into `extraction-failed`, and only `boom` throws. The
 * CLI reports them identically on purpose (`cli-spec.md` §5.6), so a fixture that needs to
 * show the non-throwing one reaching those lines names a file `twin`.
 *
 * By substring rather than by exact name because discovery sorts by path, and a fixture that
 * needs two files of one behaviour, or needs a given behaviour to arrive second, has to be
 * free to name them — which a prefix rule is not enough for, since `bad` sorts before `boom`
 * whatever follows it.
 */
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
      // More than one recoverable error on a single file, which is what a real grammar
      // produces: tree-sitter raises an ERROR per construct it could not place, so the CLI's
      // per-file line has to summarize rather than print them all.
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
      extKind: null,
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
    // One id, two declarations — the shape a plugin that forgot to fold merged declarations
    // produces. Nothing throws; the core refuses the pair.
    return ctx.file.path.includes("twin") ? [at(1), at(7)] : [at(1)]
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
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
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
  return fakeGit({ onWorktreeAdd: (dir) => populate(dir, baseFiles) }).runner
}
