/**
 * Deterministic response cache for the LSP enrichment pass (lsp-enrichment.md §10.1).
 * Responses are captured as they arrive from parallel workers, then consumed in a
 * fixed order (Symbol id asc, call-site line asc) when populating IR fields. This
 * makes the pass's output independent of wall-clock arrival order.
 */

import type { LspFailure } from "./client"

export type RequestKind = "hover" | "typeDefinition" | "implementation" | "documentSymbol"

export interface CacheKey {
  file: string
  line: number
  column: number
  kind: RequestKind
}

export interface LspCache {
  set(key: CacheKey, value: unknown | LspFailure): void
  get(key: CacheKey): unknown | LspFailure | undefined
  has(key: CacheKey): boolean
}

export function createLspCache(): LspCache {
  const store = new Map<string, unknown | LspFailure>()
  return {
    set(key, value) {
      store.set(serializeKey(key), value)
    },
    get(key) {
      return store.get(serializeKey(key))
    },
    has(key) {
      return store.has(serializeKey(key))
    },
  }
}

function serializeKey(key: CacheKey): string {
  return `${key.kind}\t${key.file}\t${key.line}\t${key.column}`
}
