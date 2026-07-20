import {
  type DocumentSymbol,
  DocumentSymbolRequest,
  HoverRequest,
  ImplementationRequest,
  type Location,
  type LocationLink,
  type MarkupContent,
  type Position,
  type SymbolInformation,
  TypeDefinitionRequest,
} from "vscode-languageserver-protocol"
import type { LspClient, LspFailure } from "./client"

/**
 * Typed wrappers around the 4 LSP requests the enrichment pass uses
 * (lsp-enrichment.md §4.2). Every wrapper takes an explicit `timeoutMs` so callers
 * can enforce §4.4 per-request budgets uniformly.
 */

export interface DocSymbolHover {
  raw: string | null
}

export async function requestDocumentSymbols(
  client: LspClient,
  uri: string,
  timeoutMs: number,
): Promise<DocumentSymbol[] | SymbolInformation[] | LspFailure> {
  return await client
    .request<DocumentSymbol[] | SymbolInformation[] | null>(
      DocumentSymbolRequest.method,
      { textDocument: { uri } },
      timeoutMs,
    )
    .then((res) => (res === null ? [] : res))
}

export async function requestHover(
  client: LspClient,
  uri: string,
  position: Position,
  timeoutMs: number,
): Promise<{ text: string } | null | LspFailure> {
  const res = await client.request<{ contents: unknown } | null>(
    HoverRequest.method,
    { textDocument: { uri }, position },
    timeoutMs,
  )
  if (res === null) return null
  if (isFailureShape(res)) return res
  const text = extractHoverText(res.contents)
  return text === null ? null : { text }
}

export async function requestTypeDefinition(
  client: LspClient,
  uri: string,
  position: Position,
  timeoutMs: number,
): Promise<Location[] | LspFailure> {
  const res = await client.request<Location | Location[] | LocationLink[] | null>(
    TypeDefinitionRequest.method,
    { textDocument: { uri }, position },
    timeoutMs,
  )
  if (res === null) return []
  if (isFailureShape(res)) return res
  return normalizeLocations(res)
}

export async function requestImplementation(
  client: LspClient,
  uri: string,
  position: Position,
  timeoutMs: number,
): Promise<Location[] | LspFailure> {
  const res = await client.request<Location | Location[] | LocationLink[] | null>(
    ImplementationRequest.method,
    { textDocument: { uri }, position },
    timeoutMs,
  )
  if (res === null) return []
  if (isFailureShape(res)) return res
  return normalizeLocations(res)
}

function isFailureShape(value: unknown): value is LspFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ((value as { kind: unknown }).kind === "timeout" ||
      (value as { kind: unknown }).kind === "error")
  )
}

function normalizeLocations(input: Location | Location[] | LocationLink[]): Location[] {
  if (Array.isArray(input)) {
    if (input.length === 0) return []
    const head = input[0]
    if (head !== undefined && "targetUri" in head) {
      return (input as LocationLink[]).map((link) => ({
        uri: link.targetUri,
        range: link.targetRange,
      }))
    }
    return input as Location[]
  }
  return [input]
}

function extractHoverText(contents: unknown): string | null {
  if (contents === null || contents === undefined) return null
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) {
    const pieces = contents.map((c) => extractHoverText(c)).filter((c): c is string => c !== null)
    return pieces.length === 0 ? null : pieces.join("\n")
  }
  if (typeof contents === "object") {
    const c = contents as MarkupContent & { language?: string; value?: string }
    if (typeof c.value === "string") return c.value
  }
  return null
}
