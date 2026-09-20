import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import type { ParseError, ParseResult, SourceFile } from "@aburi/types"
import { Language, type Node, Parser, type Tree } from "web-tree-sitter"
import { walkDescendants } from "./ast-helpers"
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
 * Every ERROR and MISSING node in the tree, in source order, less the ones `isJsxEntityArtifact`
 * identifies as the grammar's own. Both kinds are recoverable per web-tree-sitter's semantics —
 * the tree is still usable, just imperfect — so the pipeline continues. Anonymous children are
 * walked too (a MISSING `)` is one), and a subtree with no error in it is pruned.
 */
function collectParseErrors(tree: Tree): ParseError[] {
  const root = tree.rootNode
  if (!root.hasError) return []
  const errors: ParseError[] = []
  for (const node of walkDescendants(root, { anonymous: true, descend: (n) => n.hasError })) {
    const message = node.isError ? "syntax error" : node.isMissing ? "missing token" : null
    if (message === null) continue
    if (node.isError && isJsxEntityArtifact(node)) continue
    errors.push({
      message,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      recoverable: true,
    })
  }
  return errors
}

/**
 * The tokens whose presence in an unplaceable run means the file, not the grammar, is at fault.
 *
 * JSX text is delimited by exactly these four characters: `<` and `>` open and close a tag, and
 * `{` and `}` an expression container. Everything else between two tags is text the grammar
 * accepts. So a run that holds one of them is a real syntax error — a bare `}` or `>` in JSX text
 * is TS1381 / TS1382, which `tsc` and Babel both reject — while a run of ordinary words is not.
 *
 * Only inside a JSX element's children. An attribute's *string value* is a string literal, where
 * all four are ordinary characters: `href="/x?a=1&b=2}"` is legal, and refusing it here would
 * make the warning over-report the thing it is meant to stop over-reporting.
 */
const JSX_TEXT_DELIMITERS: ReadonlySet<string> = new Set(["{", "}", "<", ">"])

/**
 * Whether this ERROR is the tsx grammar's `&` limitation rather than something wrong with the
 * file (`lang-plugin.md` LP27a).
 *
 * The tsx grammar `@vscode/tree-sitter-wasm` ships reads `&` inside JSX as the opening of an
 * HTML character reference and errors when no `;` closes it. So `<CardTitle>Subscription &
 * Billing</CardTitle>` and `href="/x?utm_source=a&utm_medium=b"` — ordinary prose and a tracking
 * URL — are parse errors, while `&amp;`, `&nbsp;` and `{"a & b"}` are not. No published grammar
 * has fixed it as of 2026-09, and the dependency is a `^0.3.1` range, so this is not waiting on a
 * version bump; the suite in `test/jsx-entity-artifact.test.ts` is what will say when it is.
 *
 * What it costs is the signal rather than the data: the file still reaches the IR, and the same
 * component written with `&` and with `&amp;` extracts the same Symbols — same signature, same
 * `calls[]`, including a call sited after the error. What it did cost is the CLI's
 * recoverable-parse-error warning, which on a React codebase fired on 3% of files as a matter of
 * course and stopped being worth reading.
 *
 * Three conditions, and the *first two* are what keep a broken file reporting:
 *
 *   - The run opens with a token beginning with `&` (`&`, `&&`, `&=`, `&&=` — whatever the lexer
 *     made of the misread entity). A file broken some other way does not open its run with one.
 *   - It holds none of `JSX_TEXT_DELIMITERS`. tree-sitter merges an adjacent unparseable run into
 *     one ERROR node, so without this an `&` earlier in the same JSX children swallows whatever
 *     follows it: `<div>a & } b</div>` went silent, and `a & b` with `{foo(}` on the next line
 *     went silent *and* lost `foo` from `calls[]` — while the same source on one line reported.
 *     Recovery does not give the call back either way; what this restores is the warning that the
 *     file is doubtful, which is the whole thing the filter claims not to cost.
 *   - It sits directly among a JSX element's children — which is where the grammar parents a
 *     fragment's children too, since it has no `jsx_fragment` node — or inside a JSX attribute's
 *     string value, where the delimiter rule does not apply for the reason given above.
 *
 * The position is *not* what makes it safe, and tightening it would not help. A truncation's own
 * ERROR is parented by whatever encloses the break — `statement_block`, `object`, `arrow_function`,
 * the root node itself — not reliably by `program`, and sometimes what survives is a MISSING
 * rather than an ERROR. This file's `"a stray `<` among the children"` case is parented by
 * `jsx_element`, inside the accepted position, and reports because of the token rules alone.
 */
function isJsxEntityArtifact(node: Node): boolean {
  if (node.child(0)?.type.startsWith("&") !== true) return false
  const parent = node.parent
  if (parent === null) return false
  if (parent.type === "jsx_element") return !holdsJsxTextDelimiter(node)
  return parent.type === "string" && parent.parent?.type === "jsx_attribute"
}

/** Whether any token directly in this run is one of the four characters JSX text cannot hold. */
function holdsJsxTextDelimiter(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child !== null && JSX_TEXT_DELIMITERS.has(child.type)) return true
  }
  return false
}
