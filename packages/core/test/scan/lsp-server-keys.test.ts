import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanStubs } from "../fixtures/plugins"
import { makeServerConfig } from "../lsp/fixtures/enrichment-ctx"
import { mockServerFactory } from "../lsp/fixtures/mock-server"

const workspace = useScratchWorkspace("scan-lsp-server-keys")

describe("scan — lsp.servers keys", () => {
  it("warns about a key that names none of the language plugins it loaded", async () => {
    await workspace.writeSource("a.stub", "a")
    const logger = recordingLogger()

    await scanStubs(workspace.root, {
      config: { lsp: { enabled: true, servers: { typescript: makeServerConfig() } } },
      logger,
      lspServerFactory: mockServerFactory(),
    })

    expect(logger.warnings).toContain(
      "[aburi:lsp] lsp.servers.typescript matches no loaded language plugin (loaded: stub); its server is never started",
    )
  })
})
