/**
 * Typed wrappers around the 4 LSP requests the enrichment pass uses
 * (lsp-enrichment.md). Every wrapper takes an explicit `timeoutMs` so callers
 * can enforce per-request budgets uniformly.
 */
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
import { isLspFailure, type LspClient, type LspFailure } from "./client"

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
  if (isLspFailure(res)) return res
  const text = extractHoverText(res.contents)
  return text === null ? null : { text }
}

export function requestTypeDefinition(
  client: LspClient,
  uri: string,
  position: Position,
  timeoutMs: number,
): Promise<Location[] | LspFailure> {
  return requestLocations(TypeDefinitionRequest.method, client, uri, position, timeoutMs)
}

export function requestImplementation(
  client: LspClient,
  uri: string,
  position: Position,
  timeoutMs: number,
): Promise<Location[] | LspFailure> {
  return requestLocations(ImplementationRequest.method, client, uri, position, timeoutMs)
}

/** The two location-valued requests share one wire shape, and so one wrapper. */
async function requestLocations(
  method: string,
  client: LspClient,
  uri: string,
  position: Position,
  timeoutMs: number,
): Promise<Location[] | LspFailure> {
  const res = await client.request<Location | Location[] | LocationLink[] | null>(
    method,
    { textDocument: { uri }, position },
    timeoutMs,
  )
  if (res === null) return []
  if (isLspFailure(res)) return res
  return normalizeLocations(res)
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
    const markup = contents as MarkupContent & { language?: string; value?: string }
    if (typeof markup.value === "string") return markup.value
  }
  return null
}
