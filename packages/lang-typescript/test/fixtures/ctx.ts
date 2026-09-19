import { makeExtractionCtx } from "@aburi/test-support"
import type {
  BodyExtraction,
  DropHint,
  ExtractionContext,
  ImportEdge,
  ParseError,
  ParseResult,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import {
  classifySymbolDropHint,
  extractSymbols,
  parseTypescriptFile,
  walkBody,
} from "../../src/index"

/** A literal backslash, so a fixture can spell an escape without the test file's own escaping. */
export const BACKSLASH = String.fromCharCode(92)

const DEFAULT_PATH = "src/a.ts"

/**
 * Re-exported rather than written again. The local copy built the same `ExtractionContext`
 * over the same `noopRegistry` and differed only in demanding both arguments, so a suite
 * reading `makeExtractionCtx(path, source)` could not tell which of the two it had imported —
 * and one of them would drift. The name stays reachable from the fixture module, because that
 * is where a suite looks for its helpers; the definition is the shared one every other
 * package's suites already use.
 */
export { makeExtractionCtx }

/**
 * Narrow a nullable Tree for tests that only exercise the happy path. Fails loudly when
 * the parse returned null so the missing tree does not get silently masked as an empty
 * Symbol list.
 */
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

export async function idsOf(source: string): Promise<string[]> {
  return (await symbolsOf(source)).map((s) => s.id)
}

/** The Symbol with exactly this id, or a failure naming the ids the fixture did produce. */
export async function symbolOf(source: string, id: string): Promise<SymbolCandidate<Node>> {
  const symbols = await symbolsOf(source)
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

function walkSymbol(symbol: SymbolCandidate<Node>, ctx: ExtractionContext): BodyExtraction {
  const walkCtx: WalkContext<Node> = { ...ctx, symbol }
  return walkBody(symbol, walkCtx)
}

export async function walkOf(source: string, id: string): Promise<BodyExtraction> {
  const result = await parseSource(source)
  const ctx = makeExtractionCtx(DEFAULT_PATH, source)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.id === id)
  if (target === undefined) throw new Error(`no Symbol ${id} in fixture`)
  return walkSymbol(target, ctx)
}

/** Walk the first Symbol extraction answers, for a fixture that declares exactly one. */
export async function walkFirstSymbol(source: string): Promise<BodyExtraction> {
  const result = await parseSource(source)
  const ctx = makeExtractionCtx(DEFAULT_PATH, source)
  const [target] = extractSymbols(requireTree(result.tree), ctx)
  if (target === undefined) throw new Error("no symbols in fixture")
  return walkSymbol(target, ctx)
}

export async function callsOf(source: string, id: string): Promise<string[]> {
  return (await walkOf(source, id)).calls.map((c) => c.target)
}

export async function hintOf(source: string, id: string): Promise<DropHint | null> {
  const result = await parseSource(source)
  const ctx = makeExtractionCtx(DEFAULT_PATH, source)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.id === id)
  if (target === undefined) throw new Error(`no Symbol ${id} in fixture`)
  return classifySymbolDropHint(target, ctx)
}

/** An exported class `C` holding these members, one per line. */
export function classOf(...members: string[]): string {
  return ["export class C {", ...members, "}"].join("\n")
}
