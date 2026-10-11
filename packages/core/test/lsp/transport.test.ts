import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { spawnStdioServer } from "../../src/lsp"
import { shouldUseShell } from "../../src/lsp/transport"

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

describe("shouldUseShell", () => {
  it.each<[string, NodeJS.Platform, boolean]>([
    ["typescript-language-server.cmd", "win32", true],
    ["C:\\Users\\me\\AppData\\Roaming\\npm\\PYRIGHT-LANGSERVER.CMD", "win32", true],
    ["server.bat", "win32", true],
    ["gopls.exe", "win32", false],
    ["gopls", "win32", false],
    ["/usr/local/bin/typescript-language-server", "linux", false],
    ["server.cmd", "linux", false],
    ["server.bat", "darwin", false],
  ])("spawns %s on %s through a shell: %s", (command, os, shell) => {
    expect(shouldUseShell(command, os)).toBe(shell)
  })
})
