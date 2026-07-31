import type { ChildProcess } from "node:child_process"
import type { MessageConnection } from "vscode-jsonrpc/node"
import type { SpawnedServer } from "../../../src/lsp"

/**
 * In-memory stand-in for the `vscode-jsonrpc` `MessageConnection` a real
 * `SpawnedServer` carries. Only the four members `createLspClient` touches are
 * implemented — `listen`, `sendRequest`, `sendNotification`, `dispose`.
 *
 * The point of this fixture (as opposed to `MockLspClient`, which replaces the
 * client wholesale) is that it lets a test drive `createLspClient` itself: the
 * timeout bookkeeping lives inside the client, so the seam has to sit one layer
 * below it. `"pending"` is the interesting behavior — it models a clogged pipe,
 * where the write promise simply never settles.
 */
export type SendBehavior = "resolve" | "pending" | "reject"

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
  listenCalled = false
  disposeCalled = false

  constructor(private readonly options: FakeConnectionOptions = {}) {}

  listen(): void {
    this.listenCalled = true
  }

  async sendRequest(type: unknown, params?: unknown): Promise<unknown> {
    this.requests.push({ method: methodNameOf(type), params })
    return await settle(
      this.options.request ?? "resolve",
      this.options.requestResult,
      this.options.rejectMessage,
    )
  }

  async sendNotification(type: unknown, params?: unknown): Promise<void> {
    this.notifications.push({ method: methodNameOf(type), params })
    await settle(this.options.notification ?? "resolve", undefined, this.options.rejectMessage)
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
}

/**
 * A `SpawnedServer` whose child process never exits and whose connection is a
 * `FakeConnection`. `exited` stays pending on purpose: `createLspClient` flips
 * its internal `disposed` flag when that promise settles, and a client that
 * believes its server is gone short-circuits every method under test.
 */
export function createFakeServer(options: FakeConnectionOptions = {}): FakeServer {
  const connection = new FakeConnection(options)
  const killAfterCalls: number[] = []
  const server: SpawnedServer = {
    process: {} as ChildProcess,
    connection: connection as unknown as MessageConnection,
    exited: new Promise<number | null>(() => {}),
    spawnError: Promise.resolve(null),
    async killAfter(graceMs) {
      killAfterCalls.push(graceMs)
    },
  }
  return { server, connection, killAfterCalls }
}

/**
 * `sendRequest` / `sendNotification` accept either a protocol type object
 * (`InitializeRequest.type`) or a bare method string; both carry the method
 * name the recording arrays are asserted against.
 */
function methodNameOf(type: unknown): string {
  if (typeof type === "string") return type
  if (typeof type === "object" && type !== null && "method" in type) {
    const method = (type as { method: unknown }).method
    if (typeof method === "string") return method
  }
  return "<unknown>"
}

async function settle(
  behavior: SendBehavior,
  value: unknown,
  rejectMessage: string | undefined,
): Promise<unknown> {
  if (behavior === "pending") return await new Promise<never>(() => {})
  if (behavior === "reject") throw new Error(rejectMessage ?? "fake connection write failed")
  return value
}
