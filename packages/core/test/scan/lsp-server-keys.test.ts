import { useScratchWorkspace } from "@aburi/test-support"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { oneSymbolPerFile, scanStubs } from "../fixtures/plugins"
import { makeServerConfig } from "../lsp/fixtures/enrichment-ctx"
import { mockServerFactory } from "../lsp/fixtures/mock-server"

const workspace = useScratchWorkspace("scan-lsp-server-keys")

describe("scan — lsp.servers keys", () => {
  it.each<[string, NonNullable<Config["lsp"]>, string]>([
    [
      "a key that names none of the language plugins it loaded",
      { enabled: true, servers: { typescript: makeServerConfig() } },
      "(configured: typescript; loaded: stub)",
    ],
    ["no servers at all", { enabled: true }, "(configured: none; loaded: stub)"],
  ])("reports %s, and starts no server", async (_, lsp, named) => {
    await workspace.writeSource("a.stub", "a")
    const factory = mockServerFactory()

    const result = await scanStubs(workspace.root, {
      config: { lsp },
      languages: [oneSymbolPerFile()],
      lspServerFactory: factory,
    })

    expect(result.lspWarnings).toEqual([expect.stringContaining(named)])
    expect(factory.clients.size).toBe(0)
  })
})
