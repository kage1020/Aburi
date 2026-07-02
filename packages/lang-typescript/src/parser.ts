import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import type { ParseError, ParseResult, SourceFile } from "@aburi/types"
import { Language, Parser, type Tree } from "web-tree-sitter"
import { extractImports } from "./imports"

const nodeRequire = createRequire(import.meta.url)

/**
 * Absolute filesystem paths of the WASM runtime and the two grammar wasms this plugin
 * needs. `createRequire.resolve` picks the right on-disk paths regardless of how the
 * dependency is hoisted (pnpm's per-package `node_modules`, npm's flat tree, etc.).
 */
const RUNTIME_WASM_PATH = nodeRequire.resolve("web-tree-sitter/web-tree-sitter.wasm")
const TYPESCRIPT_WASM_PATH = nodeRequire.resolve(
  "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm",
)
const TSX_WASM_PATH = nodeRequire.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm")

/** File-extension → grammar-wasm-path lookup used by parseFile to pick the right Language. */
const EXTENSION_GRAMMAR: ReadonlyMap<string, string> = new Map([
  [".ts", TYPESCRIPT_WASM_PATH],
  [".mts", TYPESCRIPT_WASM_PATH],
  [".cts", TYPESCRIPT_WASM_PATH],
  [".tsx", TSX_WASM_PATH],
])

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
 * web-tree-sitter manages stays flat across long scans. Downstream post-parse work
 * (error collection, import extraction) is wrapped in its own try/catch that calls
 * `tree.delete()` on failure, because the caller only receives the tree handle if we
 * return successfully — an exception on the way out would strand the tree in the WASM
 * heap otherwise.
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
      const errors = collectParseErrors(tree)
      const imports = extractImports(tree, file.content)
      return { tree, errors, imports }
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
 * The default grammar is TypeScript; only .tsx routes to the tsx grammar (JSX-aware).
 * Files with unknown extensions fall back to TypeScript because the pipeline should only
 * ever hand this plugin files whose extension already matched `fileExtensions`.
 */
function pickGrammarForPath(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return TYPESCRIPT_WASM_PATH
  const ext = path.slice(dot).toLowerCase()
  return EXTENSION_GRAMMAR.get(ext) ?? TYPESCRIPT_WASM_PATH
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
