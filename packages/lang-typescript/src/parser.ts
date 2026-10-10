import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import type { ParseError, ParseResult, SourceFile } from "@aburi/types"
import { Language, type Node, Parser, type Tree } from "web-tree-sitter"
import { walkDescendants } from "./ast-helpers"
import { reparseImportTypes } from "./import-type-reparse"
import { extractImports } from "./imports"

const nodeRequire = createRequire(import.meta.url)

const RUNTIME_WASM_PATH = nodeRequire.resolve("web-tree-sitter/web-tree-sitter.wasm")

const TYPESCRIPT_WASM_PATH = fileURLToPath(
  new URL("../wasm/tree-sitter-typescript.wasm", import.meta.url),
)
const TSX_WASM_PATH = fileURLToPath(new URL("../wasm/tree-sitter-tsx.wasm", import.meta.url))

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

export const TYPESCRIPT_FILE_EXTENSIONS: readonly string[] = [...EXTENSION_GRAMMAR.keys()]

let runtimeInitPromise: Promise<void> | null = null
const languageCache = new Map<string, Promise<Language>>()

async function ensureRuntimeInitialized(): Promise<void> {
  if (runtimeInitPromise !== null) return runtimeInitPromise
  const attempt = Parser.init({
    locateFile(name: string) {
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

export async function parseTypescriptFile(file: SourceFile): Promise<ParseResult<Tree>> {
  const wasmPath = pickGrammarForPath(file.path)
  await ensureRuntimeInitialized()
  const language = await loadLanguage(wasmPath)

  const parser = new Parser()
  try {
    parser.setLanguage(language)
    const { tree, errors: repairErrors } = repairedOrFirst(
      parser,
      parser.parse(file.content),
      file.content,
    )
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
      const { edges, errors: importErrors } = extractImports(tree, file.content)
      return { tree, errors: [...repairErrors, ...syntaxErrors, ...importErrors], imports: edges }
    } catch (postParseError) {
      tree.delete()
      throw postParseError
    }
  } finally {
    parser.delete()
  }
}

function repairedOrFirst(
  parser: Parser,
  first: Tree | null,
  source: string,
): { tree: Tree | null; errors: ParseError[] } {
  if (first === null || !first.rootNode.hasError) return { tree: first, errors: [] }
  let repaired: Tree | null
  try {
    repaired = reparseImportTypes(parser, first, source, (t) => collectParseErrors(t).length)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const message = `import() type reparse failed, keeping the first parse: ${reason}`
    return { tree: first, errors: [{ message, line: 1, column: 1, recoverable: true }] }
  }
  if (repaired === null) return { tree: first, errors: [] }
  first.delete()
  return { tree: repaired, errors: [] }
}

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

function collectParseErrors(tree: Tree): ParseError[] {
  const root = tree.rootNode
  if (!root.hasError) return []
  const errors: ParseError[] = []
  for (const node of walkDescendants(root, { anonymous: true, descend: (n) => n.hasError })) {
    const message = node.isError ? "syntax error" : node.isMissing ? "missing token" : null
    if (message === null) continue
    if (node.isError && (isJsxEntityArtifact(node) || isVarianceModifierArtifact(node))) continue
    errors.push({
      message,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      recoverable: true,
    })
  }
  return errors
}

const JSX_TEXT_DELIMITERS: ReadonlySet<string> = new Set(["{", "}", "<", ">"])

function isJsxEntityArtifact(node: Node): boolean {
  if (node.child(0)?.type.startsWith("&") !== true) return false
  const parent = node.parent
  if (parent === null) return false
  if (parent.type === "jsx_element") return !holdsJsxTextDelimiter(node)
  return parent.type === "string" && parent.parent?.type === "jsx_attribute"
}

function holdsJsxTextDelimiter(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child !== null && JSX_TEXT_DELIMITERS.has(child.type)) return true
  }
  return false
}

const VARIANCE_OWNERS: ReadonlySet<string> = new Set([
  "interface_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "class",
  "type_alias_declaration",
])

const CONST_OWNERS: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class",
])

const VARIANCE_MODIFIERS: ReadonlySet<string> = new Set(["in", "out", "in out"])

const UNNAMEABLE: ReadonlySet<string> = new Set([
  ...["break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete"],
  ...["do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if"],
  ...["import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw"],
  ...["true", "try", "typeof", "var", "void", "while", "with"],
  ...["implements", "interface", "let", "package", "private", "protected", "public", "static"],
  ...["yield", "await"],
  ...["any", "unknown", "never", "string", "number", "boolean", "symbol", "object", "undefined"],
  "bigint",
])

function isVarianceModifierArtifact(node: Node): boolean {
  const list = node.parent?.type === "type_parameter" ? node.parent.parent : node.parent
  const owner = list?.parent?.type ?? ""
  if (list?.type !== "type_parameters" || !VARIANCE_OWNERS.has(owner)) return false
  const words = parameterHead(list, node)
  if (words === null) return false
  const constAt = words.indexOf("const")
  if (constAt !== -1) {
    if (!CONST_OWNERS.has(owner)) return false
    words.splice(constAt, 1)
  }
  const name = words.pop()
  if (name === undefined || UNNAMEABLE.has(name)) return false
  return VARIANCE_MODIFIERS.has(words.join(" "))
}

function parameterHead(list: Node, error: Node): string[] | null {
  const pieces: Node[] = []
  let found = false
  for (let i = 0; i < list.childCount; i++) {
    const child = list.child(i)
    if (child === null) continue
    if (child.type === ",") {
      if (found) break
      pieces.length = 0
      continue
    }
    pieces.push(child)
    if (child.id === error.id || child.id === error.parent?.id) found = true
  }

  const words: string[] = []
  let inHead = false
  let closed = false
  const take = (run: Node): boolean => {
    for (let i = 0; i < run.childCount; i++) {
      const word = run.child(i)
      if (word?.type !== "identifier") return false
      words.push(word.text)
    }
    if (run.id === error.id) inHead = true
    return true
  }
  for (const piece of pieces) {
    if (piece.type === "ERROR") {
      if (closed || !take(piece)) return null
    } else if (piece.type === "type_parameter") {
      for (let i = 0; i < piece.childCount && !closed; i++) {
        const part = piece.child(i)
        if (part === null) continue
        if (part.type === "ERROR") {
          if (!take(part)) return null
        } else if (part.type === "const" || part.type === "type_identifier") {
          words.push(part.text)
        } else {
          closed = true
        }
      }
    }
  }
  return inHead ? words : null
}
