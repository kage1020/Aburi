import { makeExtractionCtx } from "@aburi/test-support"
import type {
  BodyExtraction,
  DropHint,
  ImportEdge,
  ParseError,
  ParseResult,
  SymbolCandidate,
} from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import {
  classifySymbolDropHint,
  extractSymbols,
  normalizeAst,
  parseTypescriptFile,
  walkBody,
} from "../../src/index"

/** A literal backslash, so a fixture can spell an escape without the test file's own escaping. */
export const BACKSLASH = String.fromCharCode(92)

const DEFAULT_PATH = "src/a.ts"

export { makeExtractionCtx }

export function requireTree(tree: Tree | null): Tree {
  if (tree === null) throw new Error("test fixture invariant: parse returned null")
  return tree
}

export function parseSource(source: string, path = DEFAULT_PATH): Promise<ParseResult<Tree>> {
  return parseTypescriptFile({ path, content: source })
}

/** The edges and diagnostics a parse produced, which is all an import test reads. */
export async function importsOf(
  source: string,
  path = DEFAULT_PATH,
): Promise<{ errors: ParseError[]; imports: ImportEdge[] }> {
  const result = await parseSource(source, path)
  return { errors: result.errors, imports: result.imports }
}

/** Every diagnostic a parse produced, as `line:column message`. */
export async function parseErrorsOf(source: string, path = DEFAULT_PATH): Promise<string[]> {
  const { errors } = await parseSource(source, path)
  return errors.map((e) => `${e.line}:${e.column} ${e.message}`)
}

export function emptySpecifierErrors(errors: readonly ParseError[]): ParseError[] {
  return errors.filter((e) => e.message.includes("empty module specifier"))
}

export async function symbolsOf(
  source: string,
  path = DEFAULT_PATH,
): Promise<SymbolCandidate<Node>[]> {
  const result = await parseSource(source, path)
  return extractSymbols(requireTree(result.tree), makeExtractionCtx(path, source))
}

export async function idsOf(source: string, path = DEFAULT_PATH): Promise<string[]> {
  return (await symbolsOf(source, path)).map((s) => s.id)
}

/** The Symbol with exactly this id, or a failure naming the ids the fixture did produce. */
export async function symbolOf(
  source: string,
  id: string,
  path = DEFAULT_PATH,
): Promise<SymbolCandidate<Node>> {
  return requireSymbol(await symbolsOf(source, path), id)
}

function requireSymbol(symbols: SymbolCandidate<Node>[], id: string): SymbolCandidate<Node> {
  const found = symbols.find((s) => s.id === id)
  if (found === undefined) {
    throw new Error(`no Symbol ${id}; have ${symbols.map((s) => s.id).join(", ")}`)
  }
  return found
}

/** The Symbol whose id ends with `suffix`, for tests that do not care about the file part. */
export function byId(symbols: SymbolCandidate<Node>[], suffix: string): SymbolCandidate<Node> {
  const match = symbols.find((s) => s.id.endsWith(suffix))
  if (match === undefined) {
    throw new Error(
      `no symbol with id ending in "${suffix}" (have: ${symbols.map((s) => s.id).join(", ")})`,
    )
  }
  return match
}

export function normalizedOf(source: string, id: string, path = DEFAULT_PATH): Promise<string> {
  return symbolOf(source, id, path).then(normalizeAst)
}

/** What a walk of every Symbol the fixture declares found, keyed by the Symbol's id. */
export async function walksOf(
  source: string,
  path = DEFAULT_PATH,
): Promise<Map<string, BodyExtraction>> {
  const result = await parseSource(source, path)
  const ctx = makeExtractionCtx(path, source)
  const symbols = extractSymbols(requireTree(result.tree), ctx)
  return new Map(symbols.map((symbol) => [symbol.id, walkBody(symbol, { ...ctx, symbol })]))
}

export async function walkOf(
  source: string,
  id: string,
  path = DEFAULT_PATH,
): Promise<BodyExtraction> {
  const walk = (await walksOf(source, path)).get(id)
  if (walk === undefined) throw new Error(`no Symbol ${id} in fixture`)
  return walk
}

/** Walk the first Symbol extraction answers, for a fixture that declares exactly one. */
export async function walkFirstSymbol(
  source: string,
  path = DEFAULT_PATH,
): Promise<BodyExtraction> {
  const [walk] = (await walksOf(source, path)).values()
  if (walk === undefined) throw new Error("no symbols in fixture")
  return walk
}

export async function callsOf(source: string, id: string, path = DEFAULT_PATH): Promise<string[]> {
  return (await walkOf(source, id, path)).calls.map((c) => c.target)
}

export async function hintOf(source: string, id: string): Promise<DropHint | null> {
  const symbol = await symbolOf(source, id)
  return classifySymbolDropHint(symbol, makeExtractionCtx(DEFAULT_PATH, source))
}

/** An exported class `C` holding these members, one per line. */
export function classOf(...members: string[]): string {
  return ["export class C {", ...members, "}"].join("\n")
}
