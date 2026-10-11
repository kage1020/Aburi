import type { ChildProcess } from "node:child_process"
import type { MessageConnection } from "vscode-jsonrpc/node"
import type { SpawnedServer } from "../../../src/lsp"

export type SendBehavior = "resolve" | "pending" | "reject" | "throw-sync"

export interface FakeConnectionOptions {
  /** How `sendNotification` settles. Defaults to `"resolve"`. */
  notification?: SendBehavior
  /** How `sendRequest` settles. Defaults to `"resolve"`. */
  request?: SendBehavior
  /** Value `sendRequest` resolves with when `request` is `"resolve"`. */
  requestResult?: unknown
  /** Rejection message used by both `"reject"` behaviors. */
  rejectMessage?: string
}

export interface RecordedMessage {
  method: string
  params: unknown
}

export class FakeConnection {
  readonly notifications: RecordedMessage[] = []
  readonly requests: RecordedMessage[] = []
  /** `createLspClient` latches `listen()` to the first `initialize`; count pins that. */
  listenCount = 0
  disposeCalled = false

  constructor(private readonly options: FakeConnectionOptions = {}) {}

  listen(): void {
    this.listenCount += 1
  }

  sendRequest(type: unknown, params?: unknown): Promise<unknown> {
    this.requests.push({ method: methodNameOf(type), params })
    return settle(
      this.options.request ?? "resolve",
      this.options.requestResult,
      this.options.rejectMessage,
    )
  }

  sendNotification(type: unknown, params?: unknown): Promise<void> {
    this.notifications.push({ method: methodNameOf(type), params })
    return settle(
      this.options.notification ?? "resolve",
      undefined,
      this.options.rejectMessage,
    ) as Promise<void>
  }

  dispose(): void {
    this.disposeCalled = true
  }
}

export interface FakeServer {
  server: SpawnedServer
  connection: FakeConnection
  /** Grace periods `killAfter` was called with, in call order. */
  killAfterCalls: number[]
  /** Settle `exited`, which is how the client learns the server is gone. */
  exit: (code: number | null) => Promise<void>
}

export function createFakeServer(options: FakeConnectionOptions = {}): FakeServer {
  const connection = new FakeConnection(options)
  const killAfterCalls: number[] = []
  let signalExit: (code: number | null) => void = () => {}
  const exited = new Promise<number | null>((resolvePromise) => {
    signalExit = resolvePromise
  })
  const server: SpawnedServer = {
    process: {} as ChildProcess,
    connection: connection as unknown as MessageConnection,
    exited,
    spawnError: Promise.resolve(null),
    async killAfter(graceMs) {
      killAfterCalls.push(graceMs)
    },
  }
  return {
    server,
    connection,
    killAfterCalls,
    exit: async (code) => {
      signalExit(code)
      await exited
    },
  }
}

function methodNameOf(type: unknown): string {
  if (typeof type === "string") return type
  if (typeof type === "object" && type !== null && "method" in type) {
    const method = (type as { method: unknown }).method
    if (typeof method === "string") return method
  }
  return "<unknown>"
}

function settle(
  behavior: SendBehavior,
  value: unknown,
  rejectMessage: string | undefined,
): Promise<unknown> {
  const message = rejectMessage ?? "fake connection write failed"
  if (behavior === "pending") return new Promise<never>(() => {})
  if (behavior === "throw-sync") throw new Error(message)
  if (behavior === "reject") return Promise.reject(new Error(message))
  return Promise.resolve(value)
}
