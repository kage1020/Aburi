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
 *   - A single-shot `request` that never retries. Timeout resolves with an
 *     `LspTimeout` sentinel rather than throwing, so callers can bookkeep without
 *     try/catch churn.
 *   - `didOpen` / `didClose` per §4.3 discrete file boundaries.
 *   - A `shutdown` that mirrors §4.1 (`shutdown` request → `exit` notification →
 *     1 s → SIGKILL).
 *
 * Every write is bounded, notifications included: a JSON-RPC notification is
 * fire-and-forget, but the write still awaits the transport, so a clogged pipe
 * parks it exactly the way it parks a request. Which budget bounds which
 * notification, and why, is specified in lsp-enrichment.md §4.4 — that table is
 * the single source of truth and the call sites here only name their argument.
 *
 * Notifications report their outcome the way `request` does: `null` for a write
 * that landed, an `LspFailure` for one that timed out, was rejected, or was
 * addressed to a server already known to be gone. Nothing throws, and there is
 * no third state — an implementation cannot accidentally claim success by
 * falling off the end.
 */
export interface LspClient {
  initialize(input: InitializeInput): Promise<InitializeResult | LspFailure>
  didOpen(
    uri: string,
    languageId: string,
    text: string,
    timeoutMs: number,
  ): Promise<LspFailure | null>
  didClose(uri: string, timeoutMs: number): Promise<LspFailure | null>
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

/**
 * The one grace period `shutdown` is built from (lsp-enrichment.md §4.1). It
 * bounds three steps that run in sequence — the `shutdown` request, the `exit`
 * notification, and the wait before SIGKILL — so a server that answers none of
 * them delays the pass by at most three of these, not indefinitely.
 */
export const SHUTDOWN_GRACE_MS = 1000

export function isLspFailure(value: unknown): value is LspFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ((value as { kind: unknown }).kind === "timeout" ||
      (value as { kind: unknown }).kind === "error")
  )
}

/**
 * Every operation addressed to a server that has already exited fails this way
 * — request and notification alike. A notification is the case worth stating:
 * the write would resolve against a dead pipe and look like a success, and the
 * pass would go on treating files as opened on a server that is not there.
 */
const SERVER_DISCONNECTED: LspError = Object.freeze({
  kind: "error",
  reason: "server-disconnected",
  message: "server exited",
})

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
      let result: unknown
      try {
        result = await raceTimeout(
          connection.sendRequest(InitializeRequest.type, params),
          input.timeoutMs,
        )
      } catch (error) {
        return {
          kind: "error",
          reason: "server-error",
          message: error instanceof Error ? error.message : String(error),
        }
      }
      if (isLspFailure(result)) return result
      // The handshake is not complete until `initialized` is on the wire, so a
      // write that never lands is an initialize failure. It gets the full
      // `timeoutMs` rather than what the request left over (§4.4), which is why
      // a wholly unresponsive server can cost two of them here.
      const ack = await sendNotificationBounded(
        () => connection.sendNotification(InitializedNotification.type, {}),
        input.timeoutMs,
      )
      if (isLspFailure(ack)) return ack
      return result as InitializeResult
    },

    // `timeoutMs` is the caller's per-file budget (lsp-enrichment.md §4.4): an
    // open that spends it has left nothing for the enrichment it exists to
    // enable.
    async didOpen(uri, languageId, text, timeoutMs) {
      if (disposed) return SERVER_DISCONNECTED
      return await sendNotificationBounded(
        () =>
          connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId, version: 1, text },
          }),
        timeoutMs,
      )
    },

    // `timeoutMs` is the caller's per-request budget (§4.4): closing carries no
    // enrichment, so giving up sooner starts the next file sooner.
    async didClose(uri, timeoutMs) {
      if (disposed) return SERVER_DISCONNECTED
      return await sendNotificationBounded(
        () =>
          connection.sendNotification(DidCloseTextDocumentNotification.type, {
            textDocument: { uri },
          }),
        timeoutMs,
      )
    },

    async request<T>(method: string, params: unknown, timeoutMs: number): Promise<T | LspFailure> {
      if (disposed) return SERVER_DISCONNECTED
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
        await raceTimeout(
          connection.sendRequest(ShutdownRequest.type, undefined),
          SHUTDOWN_GRACE_MS,
        )
      } catch {
        // ignore — we still fire exit + kill below
      }
      // The outcome of `exit` is deliberately discarded: `killAfter` below is
      // what actually guarantees the process goes away, so there is nothing a
      // caller could do with the news that the courtesy notice failed.
      await sendNotificationBounded(
        () => connection.sendNotification(ExitNotification.type),
        SHUTDOWN_GRACE_MS,
      )
      await server.killAfter(SHUTDOWN_GRACE_MS)
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
 * Send one notification under a deadline. Mirrors `request`'s contract — never
 * throws, resolves with `LSP_TIMEOUT` when the write does not land in time and
 * with an `LspError` when it rejects — so a caller can treat a stalled pipe and
 * a broken one the same way it already treats a stalled or broken request.
 *
 * The write is not cancelled, and for a notification that is a stronger caveat
 * than it is for a request: abandoning a request discards a result, abandoning
 * a `didOpen` leaves a document the server may still open later, after the
 * `didClose` that followed it. The pass therefore treats a timed-out `didOpen`
 * as a per-file fallback and touches nothing else in that file — it cannot know
 * what state the server ended up in.
 *
 * `send` is a thunk rather than a promise so that a transport which throws
 * synchronously — `vscode-jsonrpc` does exactly that once the connection is
 * closed or disposed — is caught here instead of escaping to the caller.
 */
async function sendNotificationBounded(
  send: () => Promise<void>,
  timeoutMs: number,
): Promise<LspFailure | null> {
  try {
    const outcome = await raceTimeout(send(), timeoutMs)
    return isLspFailure(outcome) ? outcome : null
  } catch (error) {
    return {
      kind: "error",
      reason: "server-error",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Race a promise against a timeout. On timeout resolves with `LSP_TIMEOUT`; on
 * rejection re-throws the original error so the caller can distinguish "the
 * request timed out" from "the request failed for another reason" (parse
 * error, server disconnected, etc.). Never cancels the underlying LSP request
 * (JSON-RPC has no cancellation semantics cheap enough to matter here) — a
 * late arrival is simply ignored.
 */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | LspTimeout> {
  return await new Promise<T | LspTimeout>((resolvePromise, rejectPromise) => {
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
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectPromise(error)
      },
    )
  })
}
