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

/** The message an `LspError` or a log line carries for a thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
          message: errorMessage(error),
        }
      }
      if (isLspFailure(result)) return result
      const ack = await sendNotificationBounded(
        () => connection.sendNotification(InitializedNotification.type, {}),
        input.timeoutMs,
      )
      if (isLspFailure(ack)) return ack
      return result as InitializeResult
    },

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
          message: errorMessage(error),
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
      message: errorMessage(error),
    }
  }
}

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
