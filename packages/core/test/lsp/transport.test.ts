import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { spawnStdioServer } from "../../src/lsp"

describe("spawnStdioServer", () => {
  it("reports a command that cannot be started through spawnError, and settles exited", async () => {
    const server = spawnStdioServer("aburi-no-such-lsp-server", [], tmpdir())

    expect(await server.spawnError).toBeInstanceOf(Error)
    expect(await server.exited).toBeNull()
  })

  it("kills a server that outlives its grace period", async () => {
    const server = spawnStdioServer(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      tmpdir(),
    )

    await server.killAfter(50)

    expect(await server.exited).toBeNull()
    expect(server.process.signalCode).toBe("SIGKILL")
    server.connection.dispose()
  })
})
