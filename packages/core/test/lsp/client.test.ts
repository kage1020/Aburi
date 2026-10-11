import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLspClient, LSP_TIMEOUT, type LspClient, SHUTDOWN_GRACE_MS } from "../../src/lsp"
import { createFakeServer, type FakeConnectionOptions } from "./fixtures/fake-connection"

const FILE_URI = "file:///workspace/src/a.ts"
const INITIALIZE_INPUT = {
  workspaceRoot: "/workspace",
  initializationOptions: {},
  capabilities: {},
}

type Operation = [string, (client: LspClient, timeoutMs: number) => Promise<unknown>]

const WRITES: Operation[] = [
  ["didOpen", (client, timeoutMs) => client.didOpen(FILE_URI, "typescript", "x", timeoutMs)],
  ["didClose", (client, timeoutMs) => client.didClose(FILE_URI, timeoutMs)],
  ["request", (client, timeoutMs) => client.request("textDocument/hover", {}, timeoutMs)],
]

describe("LSP client write bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(WRITES)("resolves %s with the timeout sentinel exactly at its bound", async (_, send) => {
    const { client } = makeClient({ notification: "pending", request: "pending" })
    const call = track(send(client, 50))
    await vi.advanceTimersByTimeAsync(49)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await call.result).toBe(LSP_TIMEOUT)
  })

  it.each(
    WRITES.flatMap(([name, send]) =>
      (["reject", "throw-sync"] as const).map((behavior) => [name, behavior, send] as const),
    ),
  )("reports a %s whose write fails (%s) as a server error rather than throwing", async (_, behavior, send) => {
    const { client } = makeClient({
      notification: behavior,
      request: behavior,
      rejectMessage: "EPIPE",
    })
    await expect(send(client, 1000)).resolves.toEqual({
      kind: "error",
      reason: "server-error",
      message: "EPIPE",
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

  it("reports every write as server-disconnected, and sends nothing, once the server has exited", async () => {
    const { client, connection, exit } = makeClient()
    await exit(0)
    for (const [, send] of WRITES) {
      await expect(send(client, 1000)).resolves.toEqual({
        kind: "error",
        reason: "server-disconnected",
        message: "server exited",
      })
    }
    expect(connection.notifications).toEqual([])
    expect(connection.requests).toEqual([])
  })

  it("starts listening once, on the first initialize", async () => {
    const { client, connection } = makeClient({ requestResult: { capabilities: {} } })
    expect(connection.listenCount).toBe(0)
    await client.initialize({ ...INITIALIZE_INPUT, timeoutMs: 1000 })
    await client.initialize({ ...INITIALIZE_INPUT, timeoutMs: 1000 })
    expect(connection.listenCount).toBe(1)
  })

  it("fails initialize when the initialize request rejects", async () => {
    const { client } = makeClient({ request: "reject", rejectMessage: "spawn died" })
    await expect(client.initialize({ ...INITIALIZE_INPUT, timeoutMs: 1000 })).resolves.toEqual({
      kind: "error",
      reason: "server-error",
      message: "spawn died",
    })
  })

  it("fails initialize when the initialized notification never settles", async () => {
    const { client, connection } = makeClient({
      notification: "pending",
      requestResult: { capabilities: {} },
    })
    const call = track(client.initialize({ ...INITIALIZE_INPUT, timeoutMs: 50 }))
    await vi.advanceTimersByTimeAsync(49)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await call.result).toBe(LSP_TIMEOUT)
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

  it("still sends exit and kills the server when the shutdown request fails", async () => {
    const { client, connection, killAfterCalls } = makeClient({ request: "reject" })
    await client.shutdown()
    expect(connection.notifications.map((n) => n.method)).toEqual(["exit"])
    expect(killAfterCalls).toEqual([SHUTDOWN_GRACE_MS])
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
