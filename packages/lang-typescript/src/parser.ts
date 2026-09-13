import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import type { ParseError, ParseResult, SourceFile } from "@aburi/types"
import { Language, Parser, type Tree } from "web-tree-sitter"
import { extractImports } from "./imports"

const nodeRequire = createRequire(import.meta.url)

/**
 * Absolute filesystem path of the WASM runtime. `createRequire.resolve` picks the right
 * on-disk path regardless of how the dependency is hoisted (pnpm's per-package
 * `node_modules`, npm's flat tree, etc.).
 */
const RUNTIME_WASM_PATH = nodeRequire.resolve("web-tree-sitter/web-tree-sitter.wasm")

/**
 * Absolute filesystem paths of the two grammar wasms this plugin parses with.
 *
 * They are vendored into the package's own `wasm/` by `scripts/copy-grammars.mjs` rather
 * than resolved out of `@vscode/tree-sitter-wasm`: this plugin reads two of the grammars
 * that package ships, npm cannot install part of a tarball, and keeping it a runtime
 * dependency would put all the rest on every consumer's disk.
 *
 * Two constraints hold the shape of these two lines in place.
 *
 * `../wasm/` has to resolve from both the published `dist/index.mjs` and this file under
 * `src/`, which it does because both sit exactly one directory below the package root —
 * that is why the script copies to the root and not into `dist/`. Moving either deeper
 * breaks the path.
 *
 * The specifier has to stay a literal. Vite/Rollup, webpack and esbuild rewrite
 * `new URL(<literal>, import.meta.url)` into an emitted asset, and a template literal is
 * the one form none of them touch. Building these through a helper therefore left a
 * consumer who re-bundles this package (`@vercel/ncc`, esbuild into a container) with
 * `import.meta.url` pointing at their own bundle and no `wasm/` beside it.
 */
const TYPESCRIPT_WASM_PATH = fileURLToPath(
  new URL("../wasm/tree-sitter-typescript.wasm", import.meta.url),
)
const TSX_WASM_PATH = fileURLToPath(new URL("../wasm/tree-sitter-tsx.wasm", import.meta.url))

/**
 * Refuse to load at all when the grammars are not on disk.
 *
 * `require.resolve` used to buy this for free: a missing grammar threw while this module
 * was being imported, and `plugin-loader.ts` turned that into a `CliError` naming the
 * plugin. Reading the files lazily instead defers the failure to the `readFile` in
 * `loadLanguage`, which lands in `parseFile`'s per-file catch — where an ENOENT on the
 * grammar is indistinguishable from one source file the parser choked on. The scan then
 * runs to completion, writes an IR with zero Symbols, and exits 3: the code CI gates read
 * as a healthy no-findings run. A missing dependency has to stop the run instead.
 */
for (const wasmPath of [TYPESCRIPT_WASM_PATH, TSX_WASM_PATH]) {
  if (!existsSync(wasmPath)) {
    throw new Error(
      `@aburi/lang-typescript: no grammar wasm at ${wasmPath}. That directory is build ` +
        "output rather than source: run `pnpm --filter @aburi/lang-typescript build` in a " +
        "checkout of this repository, or reinstall the package, whose published tarball " +
        "ships it.",
    )
  }
}

/**
 * File-extension → grammar-wasm-path lookup used by parseFile to pick the right Language.
 *
 * **Every JavaScript extension routes to the tsx grammar**, not only `.jsx`. The JavaScript
 * coverage exists so `@aburi/framework-react` can classify React sources in plain-JavaScript
 * codebases — and a React source written in `.js` contains JSX in `.js`: that is what
 * `create-next-app`'s JavaScript template emits and what CRA emitted. A grammar that refuses
 * JSX recovers past it rather than failing, so the file still reaches the IR: the declaration
 * usually survives, its body is error soup from the first tag onwards, and nothing inside the
 * markup — a handler's calls, the JSX a framework classifier looks for — is in the tree.
 *
 * The TypeScript extensions stay where they are, and one construct decides it: the old-style
 * type assertion `<T>expr` is the only thing the tsx grammar refuses that the TypeScript
 * grammar accepts. It is legal TypeScript and was never legal JavaScript, so it is the whole
 * of what a `.js` file gives up by moving — which is what
 * `test/javascript-with-jsx.test.ts` pins, from both directions.
 */
const EXTENSION_GRAMMAR: ReadonlyMap<string, string> = new Map([
  [".ts", TYPESCRIPT_WASM_PATH],
  [".mts", TYPESCRIPT_WASM_PATH],
  [".cts", TYPESCRIPT_WASM_PATH],
  [".tsx", TSX_WASM_PATH],
  [".js", TSX_WASM_PATH],
  [".mjs", TSX_WASM_PATH],
  [".cjs", TSX_WASM_PATH],
  [".jsx", TSX_WASM_PATH],
])

/**
 * Public list of extensions this parser accepts. Derived from `EXTENSION_GRAMMAR` so
 * `LanguagePlugin.fileExtensions` and the grammar dispatch cannot drift apart — adding
 * an entry to the map is the single change needed to extend coverage.
 */
export const TYPESCRIPT_FILE_EXTENSIONS: readonly string[] = [...EXTENSION_GRAMMAR.keys()]

let runtimeInitPromise: Promise<void> | null = null
const languageCache = new Map<string, Promise<Language>>()

/**
 * Initialize the tree-sitter WASM runtime exactly once per process. Every subsequent
 * parseFile call awaits the same promise, so the expensive Emscripten setup happens once
 * regardless of concurrency.
 *
 * A rejection is de-cached before it propagates: a transient I/O failure would otherwise
 * poison the shared promise for the rest of the process lifetime and every future parse
 * would fail without a way to recover.
 */
async function ensureRuntimeInitialized(): Promise<void> {
  if (runtimeInitPromise !== null) return runtimeInitPromise
  const attempt = Parser.init({
    locateFile(name: string) {
      // Emscripten asks for the WASM runtime by its default filename; return our on-disk
      // path so the loader does not go looking on the network.
      if (name === "tree-sitter.wasm" || name === "web-tree-sitter.wasm") {
        return RUNTIME_WASM_PATH
      }
      return name
    },
  }).catch((err: unknown) => {
    runtimeInitPromise = null
    throw err
  })
  runtimeInitPromise = attempt
  return attempt
}

/**
 * Load (or reuse) the Language for a given grammar wasm path. Cached per process. A
 * rejected load is evicted from the cache so a transient read failure does not lock the
 * grammar out for the rest of the run.
 */
async function loadLanguage(wasmPath: string): Promise<Language> {
  const cached = languageCache.get(wasmPath)
  if (cached !== undefined) return cached
  const attempt = readFile(wasmPath)
    .then((bytes) => Language.load(new Uint8Array(bytes)))
    .catch((err: unknown) => {
      languageCache.delete(wasmPath)
      throw err
    })
  languageCache.set(wasmPath, attempt)
  return attempt
}

/**
 * Parse a single TypeScript / TSX source file.
 *
 * Every call creates a fresh Parser and releases it in a `finally` so the WASM heap that
 * web-tree-sitter manages stays flat across long scans. The tree outlives this function and
 * is the caller's to free, through the plugin's `releaseTree`.
 *
 * Downstream post-parse work (error collection, import extraction) is wrapped in its own
 * try/catch that calls `tree.delete()` on failure. That is the one path where the tree is
 * still ours: the caller only receives the handle if we return successfully, so an exception
 * on the way out would strand it in the WASM heap with nobody able to reach it.
 *
 * When the parser returns null (a genuinely unrecoverable case — typically an OOM),
 * `tree` is null on the result too and `errors[]` carries a `recoverable: false` entry.
 * Callers must check `tree === null` before dispatching to extractSymbols / walkBody /
 * normalizeAst.
 */
export async function parseTypescriptFile(file: SourceFile): Promise<ParseResult<Tree>> {
  const wasmPath = pickGrammarForPath(file.path)
  await ensureRuntimeInitialized()
  const language = await loadLanguage(wasmPath)

  const parser = new Parser()
  try {
    parser.setLanguage(language)
    const tree = parser.parse(file.content)
    if (tree === null) {
      return {
        tree: null,
        errors: [
          {
            message: "web-tree-sitter Parser.parse returned null",
            line: 1,
            column: 1,
            recoverable: false,
          },
        ],
        imports: [],
      }
    }
    try {
      const syntaxErrors = collectParseErrors(tree)
      // An import site the reader refused reports through the same channel a syntax error
      // does: both leave a usable tree and both are the author's to fix.
      const { edges, errors: importErrors } = extractImports(tree, file.content)
      return { tree, errors: [...syntaxErrors, ...importErrors], imports: edges }
    } catch (postParseError) {
      // Release the tree before propagating; otherwise the WASM handle leaks because the
      // caller never receives it.
      tree.delete()
      throw postParseError
    }
  } finally {
    parser.delete()
  }
}

/**
 * Look up the grammar wasm path for `path`'s extension. Throws when the extension is not
 * in `EXTENSION_GRAMMAR`: the pipeline should only ever hand this plugin files whose
 * extension already matched `fileExtensions`, so an unknown extension here is a
 * configuration bug (or a caller bypassing the pipeline) — silently falling back to the
 * TypeScript grammar would misparse the input and hide the misconfiguration.
 */
function pickGrammarForPath(path: string): string {
  const dot = path.lastIndexOf(".")
  const ext = dot < 0 ? "" : path.slice(dot).toLowerCase()
  const grammar = EXTENSION_GRAMMAR.get(ext)
  if (grammar === undefined) {
    throw new Error(
      `@aburi/lang-typescript: no grammar registered for extension "${ext}" (path: ${path}). ` +
        `Accepted extensions: ${[...EXTENSION_GRAMMAR.keys()].join(", ")}.`,
    )
  }
  return grammar
}

/**
 * Walk the tree to collect every syntax error node. Tree-sitter reports individual
 * ERROR nodes and MISSING nodes; both are recoverable per web-tree-sitter's semantics —
 * the tree is still usable, just imperfect — so we mark them recoverable and let the
 * pipeline continue.
 */
function collectParseErrors(tree: Tree): ParseError[] {
  const errors: ParseError[] = []
  const root = tree.rootNode
  if (!root.hasError) return errors
  const stack: Array<{ type: "error" | "missing"; row: number; col: number }> = []
  walkForErrors(root, stack)
  for (const { row, col, type } of stack) {
    errors.push({
      message: type === "missing" ? "missing token" : "syntax error",
      line: row + 1,
      column: col + 1,
      recoverable: true,
    })
  }
  return errors
}

function walkForErrors(
  node: import("web-tree-sitter").Node,
  out: Array<{ type: "error" | "missing"; row: number; col: number }>,
): void {
  if (node.isError) {
    out.push({ type: "error", row: node.startPosition.row, col: node.startPosition.column })
  } else if (node.isMissing) {
    out.push({ type: "missing", row: node.startPosition.row, col: node.startPosition.column })
  }
  if (!node.hasError) return
  for (const child of node.children) {
    if (child !== null) walkForErrors(child, out)
  }
}
