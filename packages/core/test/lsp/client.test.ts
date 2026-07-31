import { describe, expect, it } from "vitest"
import { createLspClient, isLspFailure, LSP_TIMEOUT } from "../../src/lsp"
import { createFakeServer, type FakeConnectionOptions } from "./fixtures/fake-connection"

const WORKSPACE_ROOT = "/workspace"
const FILE_URI = "file:///workspace/src/a.ts"

/**
 * `createLspClient` bounds every JSON-RPC write it makes, notifications
 * included. A notification that never settles (a clogged stdio pipe, backpressure
 * on a large `didOpen`) used to park the enrichment pass forever, ahead of the
 * `fileBudgetMs` monitoring that only starts once a request is issued.
 */
describe("LSP client notification bounds", () => {
  it("resolves didOpen with the timeout sentinel when the write never settles", async () => {
    const { client, connection } = makeClient({ notification: "pending" })
    const startedAt = Date.now()
    const result = await client.didOpen(FILE_URI, "typescript", "const x = 1", 50)
    expect(result).toBe(LSP_TIMEOUT)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40)
    expect(connection.notifications.map((n) => n.method)).toEqual(["textDocument/didOpen"])
  })

  it("resolves didOpen with a server-error failure when the write rejects", async () => {
    const { client } = makeClient({ notification: "reject", rejectMessage: "EPIPE" })
    const result = await client.didOpen(FILE_URI, "typescript", "const x = 1", 1000)
    expect(result).toEqual({ kind: "error", reason: "server-error", message: "EPIPE" })
  })

  it("sends the didOpen params unchanged and resolves with no failure on the happy path", async () => {
    const { client, connection } = makeClient()
    const result = await client.didOpen(FILE_URI, "typescript", "const x = 1", 1000)
    expect(result).toBeUndefined()
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

  it("resolves didClose with the timeout sentinel when the write never settles", async () => {
    const { client, connection } = makeClient({ notification: "pending" })
    const startedAt = Date.now()
    const result = await client.didClose(FILE_URI, 50)
    expect(result).toBe(LSP_TIMEOUT)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40)
    expect(connection.notifications.map((n) => n.method)).toEqual(["textDocument/didClose"])
  })

  it("fails initialize when the initialized notification never settles", async () => {
    const { client, connection } = makeClient({
      notification: "pending",
      requestResult: { capabilities: {} },
    })
    const result = await client.initialize({
      workspaceRoot: WORKSPACE_ROOT,
      initializationOptions: {},
      capabilities: {},
      timeoutMs: 50,
    })
    expect(isLspFailure(result)).toBe(true)
    expect(connection.requests.map((r) => r.method)).toEqual(["initialize"])
    expect(connection.notifications.map((n) => n.method)).toEqual(["initialized"])
  })

  it("completes shutdown even when the exit notification never settles", async () => {
    const { client, connection, killAfterCalls } = makeClient({
      notification: "pending",
      requestResult: null,
    })
    await client.shutdown()
    expect(connection.requests.map((r) => r.method)).toEqual(["shutdown"])
    expect(connection.notifications.map((n) => n.method)).toEqual(["exit"])
    expect(killAfterCalls).toEqual([1000])
    expect(connection.disposeCalled).toBe(true)
  })
})

function makeClient(options: FakeConnectionOptions = {}) {
  const fake = createFakeServer(options)
  return { ...fake, client: createLspClient(fake.server) }
}
