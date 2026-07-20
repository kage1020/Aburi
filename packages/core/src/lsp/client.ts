import { pathToFileURL } from "node:url"
import {
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  type InitializeResult,
  ShutdownRequest,
} from "vscode-languageserver-protocol"
import type { SpawnedServer } from "./transport"

/**
 * LSP client contract used by the enrichment pass. Wraps `vscode-jsonrpc` and adds:
 *   - A single-shot `request` that never retries (LE18). Timeout resolves with an
 *     `LspTimeout` sentinel rather than throwing, so callers can bookkeep without
 *     try/catch churn.
 *   - `didOpen` / `didClose` per §4.3 discrete file boundaries.
 *   - A `shutdown` that mirrors §4.1 (`shutdown` request → `exit` notification →
 *     1 s → SIGKILL).
 */
export interface LspClient {
  initialize(input: InitializeInput): Promise<InitializeResult | LspFailure>
  didOpen(uri: string, languageId: string, text: string): Promise<void>
  didClose(uri: string): Promise<void>
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T | LspFailure>
  shutdown(): Promise<void>
}

export interface InitializeInput {
  workspaceRoot: string
  initializationOptions: unknown
  capabilities: object
  timeoutMs: number
}

export type LspFailure = LspTimeout | LspError
export interface LspTimeout {
  kind: "timeout"
}
export interface LspError {
  kind: "error"
  reason: "server-error" | "server-disconnected" | "parse-error"
  message: string
}

export const LSP_TIMEOUT: LspTimeout = Object.freeze({ kind: "timeout" })

export function isLspFailure(value: unknown): value is LspFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ((value as { kind: unknown }).kind === "timeout" ||
      (value as { kind: unknown }).kind === "error")
  )
}

export function createLspClient(server: SpawnedServer): LspClient {
  const connection = server.connection
  let listening = false
  let disposed = false

  server.exited.then(() => {
    disposed = true
  })

  return {
    async initialize(input) {
      const params = {
        processId: process.pid,
        rootUri: pathToFileURL(input.workspaceRoot).toString(),
        capabilities: input.capabilities,
        initializationOptions: input.initializationOptions,
        workspaceFolders: [
          { uri: pathToFileURL(input.workspaceRoot).toString(), name: "workspace" },
        ],
      }
      if (!listening) {
        connection.listen()
        listening = true
      }
      const result = await raceTimeout(
        connection.sendRequest(InitializeRequest.type, params),
        input.timeoutMs,
      )
      if (isLspFailure(result)) return result
      await connection.sendNotification(InitializedNotification.type, {})
      return result as InitializeResult
    },

    async didOpen(uri, languageId, text) {
      if (disposed) return
      await connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text },
      })
    },

    async didClose(uri) {
      if (disposed) return
      await connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      })
    },

    async request<T>(method: string, params: unknown, timeoutMs: number): Promise<T | LspFailure> {
      if (disposed)
        return { kind: "error", reason: "server-disconnected", message: "server exited" }
      try {
        const raw = await raceTimeout(connection.sendRequest<T>(method, params), timeoutMs)
        return raw
      } catch (error) {
        return {
          kind: "error",
          reason: "server-error",
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async shutdown() {
      if (disposed) return
      try {
        await raceTimeout(connection.sendRequest(ShutdownRequest.type, undefined), 1000)
      } catch {
        // ignore — we still fire exit + kill below
      }
      try {
        await connection.sendNotification(ExitNotification.type)
      } catch {
        // ignore
      }
      await server.killAfter(1000)
      try {
        connection.dispose()
      } catch {
        // ignore
      }
      disposed = true
    },
  }
}

/**
 * Race a promise against a timeout. On timeout resolves with `LSP_TIMEOUT`.
 * NEVER cancels the underlying LSP request (JSON-RPC has no cancellation semantics
 * cheap enough to matter here) — the response is simply ignored on arrival.
 */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | LspTimeout> {
  return await new Promise<T | LspTimeout>((resolvePromise) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolvePromise(LSP_TIMEOUT)
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(LSP_TIMEOUT)
      },
    )
  })
}
