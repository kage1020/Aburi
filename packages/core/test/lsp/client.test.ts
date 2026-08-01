import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLspClient, isLspFailure, LSP_TIMEOUT, SHUTDOWN_GRACE_MS } from "../../src/lsp"
import { createFakeServer, type FakeConnectionOptions } from "./fixtures/fake-connection"

const WORKSPACE_ROOT = "/workspace"
const FILE_URI = "file:///workspace/src/a.ts"

/**
 * `createLspClient` bounds every JSON-RPC write it makes, notifications
 * included. A notification that never settles (a clogged stdio pipe, a large
 * `didOpen` meeting backpressure) used to park the enrichment pass forever,
 * ahead of the `fileBudgetMs` monitoring that only starts once a request is
 * issued.
 *
 * Timers are faked so each bound is pinned from both sides — unresolved at
 * `timeoutMs - 1`, resolved at `timeoutMs`. A one-sided "took at least N ms"
 * assertion would pass just as happily against a bound ten times too large,
 * which is the very defect these tests exist to prevent.
 */
describe("LSP client write bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves didOpen with the timeout sentinel exactly at its bound", async () => {
    const { client, connection } = makeClient({ notification: "pending" })
    const call = track(client.didOpen(FILE_URI, "typescript", "const x = 1", 50))
    await vi.advanceTimersByTimeAsync(49)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await call.result).toBe(LSP_TIMEOUT)
    expect(connection.notifications.map((n) => n.method)).toEqual(["textDocument/didOpen"])
  })

  it("resolves didClose with the timeout sentinel exactly at its bound", async () => {
    const { client, connection } = makeClient({ notification: "pending" })
    const call = track(client.didClose(FILE_URI, 120))
    await vi.advanceTimersByTimeAsync(119)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await call.result).toBe(LSP_TIMEOUT)
    expect(connection.notifications.map((n) => n.method)).toEqual(["textDocument/didClose"])
  })

  it("reports a rejected write as a server error rather than throwing", async () => {
    const { client } = makeClient({ notification: "reject", rejectMessage: "EPIPE" })
    await expect(client.didOpen(FILE_URI, "typescript", "const x = 1", 1000)).resolves.toEqual({
      kind: "error",
      reason: "server-error",
      message: "EPIPE",
    })
    await expect(client.didClose(FILE_URI, 1000)).resolves.toEqual({
      kind: "error",
      reason: "server-error",
      message: "EPIPE",
    })
  })

  it("reports a synchronously thrown write as a server error", async () => {
    // `vscode-jsonrpc` throws, rather than rejecting, once the connection is
    // closed or disposed — the likeliest shape of "the server died mid-pass".
    const { client } = makeClient({
      notification: "throw-sync",
      rejectMessage: "connection closed",
    })
    await expect(client.didOpen(FILE_URI, "typescript", "const x = 1", 1000)).resolves.toEqual({
      kind: "error",
      reason: "server-error",
      message: "connection closed",
    })
  })

  it("sends the didOpen params unchanged and reports no failure on the happy path", async () => {
    const { client, connection } = makeClient()
    await expect(client.didOpen(FILE_URI, "typescript", "const x = 1", 1000)).resolves.toBeNull()
    expect(connection.notifications).toEqual([
      {
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: FILE_URI,
            languageId: "typescript",
            version: 1,
            text: "const x = 1",
          },
        },
      },
    ])
  })

  it("reports every write as server-disconnected once the server has exited", async () => {
    const { client, connection, exit } = makeClient()
    await exit(0)
    const disconnected = { kind: "error", reason: "server-disconnected", message: "server exited" }
    await expect(client.didOpen(FILE_URI, "typescript", "const x = 1", 1000)).resolves.toEqual(
      disconnected,
    )
    await expect(client.didClose(FILE_URI, 1000)).resolves.toEqual(disconnected)
    await expect(client.request("textDocument/documentSymbol", {}, 1000)).resolves.toEqual(
      disconnected,
    )
    // Nothing was put on a wire whose far end is gone.
    expect(connection.notifications).toEqual([])
    expect(connection.requests).toEqual([])
  })

  it("starts listening once, on the first initialize", async () => {
    const { client, connection } = makeClient({ requestResult: { capabilities: {} } })
    expect(connection.listenCount).toBe(0)
    const input = {
      workspaceRoot: WORKSPACE_ROOT,
      initializationOptions: {},
      capabilities: {},
      timeoutMs: 1000,
    }
    await client.initialize(input)
    await client.initialize(input)
    expect(connection.listenCount).toBe(1)
  })

  it("fails initialize when the initialize request rejects", async () => {
    const { client } = makeClient({ request: "reject", rejectMessage: "spawn died" })
    const result = await client.initialize({
      workspaceRoot: WORKSPACE_ROOT,
      initializationOptions: {},
      capabilities: {},
      timeoutMs: 1000,
    })
    expect(result).toEqual({ kind: "error", reason: "server-error", message: "spawn died" })
  })

  it("fails initialize when the initialized notification never settles", async () => {
    const { client, connection } = makeClient({
      notification: "pending",
      requestResult: { capabilities: {} },
    })
    const call = track(
      client.initialize({
        workspaceRoot: WORKSPACE_ROOT,
        initializationOptions: {},
        capabilities: {},
        timeoutMs: 50,
      }),
    )
    await vi.advanceTimersByTimeAsync(49)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(isLspFailure(await call.result)).toBe(true)
    expect(connection.requests.map((r) => r.method)).toEqual(["initialize"])
    expect(connection.notifications.map((n) => n.method)).toEqual(["initialized"])
  })

  it("completes shutdown within its grace period when the exit notification never settles", async () => {
    const { client, connection, killAfterCalls } = makeClient({
      notification: "pending",
      requestResult: null,
    })
    const call = track(client.shutdown())
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await call.result
    expect(connection.requests.map((r) => r.method)).toEqual(["shutdown"])
    expect(connection.notifications.map((n) => n.method)).toEqual(["exit"])
    expect(killAfterCalls).toEqual([SHUTDOWN_GRACE_MS])
    expect(connection.disposeCalled).toBe(true)
  })
})

function makeClient(options: FakeConnectionOptions = {}) {
  const fake = createFakeServer(options)
  return { ...fake, client: createLspClient(fake.server) }
}

/** Observe whether a promise has settled without awaiting it. */
function track<T>(promise: Promise<T>): { result: Promise<T>; readonly settled: boolean } {
  let done = false
  const result = promise.then((value) => {
    done = true
    return value
  })
  return {
    result,
    get settled() {
      return done
    },
  }
}
