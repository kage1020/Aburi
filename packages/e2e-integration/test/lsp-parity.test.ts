import type { LspClient, LspFailure, ServerFactory } from "@aburi/core"
import type { Symbol as IRSymbol, LspServerConfig } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { scanFixture } from "../src/scan-helper"

/**
 * Healthy in-memory LSP mock: satisfies initialize, returns [] for
 * documentSymbol and null for hover. Enrichment runs to completion — issuing
 * documentSymbol per file — but resolves no receivers and adds no inferred
 * throws. That is exactly the shape the api / syntax fingerprint invariance
 * needs to be proved against: enrichment ran, but the IR fields those hashes
 * cover never changed.
 */
function healthyMockFactory(): ServerFactory {
  return () => {
    const client: LspClient = {
      async initialize() {
        return { capabilities: {} }
      },
      async didOpen() {},
      async didClose() {},
      async request(): Promise<never | LspFailure> {
        return null as never
      },
      async shutdown() {},
    }
    return client
  }
}

/**
 * Erroring LSP mock: initialize succeeds but every request returns an
 * `LspError`. Every request path exercises per-request fallback bookkeeping.
 */
function erroringMockFactory(): ServerFactory {
  return () => {
    const client: LspClient = {
      async initialize() {
        return { capabilities: {} }
      },
      async didOpen() {},
      async didClose() {},
      async request(): Promise<never | LspFailure> {
        return { kind: "error", reason: "server-error", message: "injected" }
      },
      async shutdown() {},
    }
    return client
  }
}

/**
 * Fingerprint parity across LSP toggles. The theorem the LSP enrichment
 * design commits to is: for every Symbol S, `S.fingerprint.api` and
 * `S.fingerprint.syntax` are byte-identical between an LSP-off scan and an
 * LSP-on scan of the same source tree. `S.fingerprint.logic` may differ when
 * LSP resolves a call whose transitive closure carries a classified effect —
 * but only then.
 */
describe("LSP fingerprint parity across enablement", () => {
  it("keeps api and syntax fingerprints byte-identical when a healthy LSP server runs", async () => {
    const { root, cleanup } = await checkoutFixture("lsp-parity")
    try {
      const off = await scanFixture(root, {})
      const on = await scanFixture(
        root,
        { lsp: { enabled: true, servers: { ts: baseServerConfig } } },
        {},
        [],
        healthyMockFactory(),
      )
      // Confirm the enrichment pass actually ran — otherwise this test would
      // just be measuring "LSP off vs LSP off with an unused config".
      expect(on.ir.stats.lspEnrichment).toBeDefined()
      expect(on.ir.stats.lspEnrichment?.requestsIssued ?? 0).toBeGreaterThan(0)

      const offById = indexById(off.ir.symbols)
      const onById = indexById(on.ir.symbols)
      expect([...offById.keys()].sort()).toEqual([...onById.keys()].sort())
      for (const id of offById.keys()) {
        const offS = offById.get(id) as IRSymbol
        const onS = onById.get(id) as IRSymbol
        expect(onS.fingerprint.api, `api mismatch for ${id}`).toBe(offS.fingerprint.api)
        expect(onS.fingerprint.syntax, `syntax mismatch for ${id}`).toBe(offS.fingerprint.syntax)
        // Signature.throws MUST NOT change; inferredThrows is a separate field.
        expect(onS.signature?.throws ?? []).toEqual(offS.signature?.throws ?? [])
      }
    } finally {
      await cleanup()
    }
  })

  it("keeps api and syntax fingerprints byte-identical when every LSP request errors", async () => {
    const { root, cleanup } = await checkoutFixture("lsp-parity")
    try {
      const off = await scanFixture(root, {})
      const on = await scanFixture(
        root,
        { lsp: { enabled: true, servers: { ts: baseServerConfig } } },
        {},
        [],
        erroringMockFactory(),
      )
      expect(on.ir.stats.lspEnrichment?.requestsFailed ?? 0).toBeGreaterThan(0)
      const offById = indexById(off.ir.symbols)
      const onById = indexById(on.ir.symbols)
      for (const id of offById.keys()) {
        const offS = offById.get(id) as IRSymbol
        const onS = onById.get(id) as IRSymbol
        expect(onS.fingerprint.api).toBe(offS.fingerprint.api)
        expect(onS.fingerprint.syntax).toBe(offS.fingerprint.syntax)
      }
    } finally {
      await cleanup()
    }
  })

  it("keeps logic fingerprints identical when no LSP-newly-resolved edge reaches a classified effect", async () => {
    const { root, cleanup } = await checkoutFixture("lsp-parity")
    try {
      const off = await scanFixture(root, {})
      const on = await scanFixture(
        root,
        { lsp: { enabled: true, servers: { ts: baseServerConfig } } },
        {},
        [],
        healthyMockFactory(),
      )
      const offById = indexById(off.ir.symbols)
      const onById = indexById(on.ir.symbols)
      for (const id of offById.keys()) {
        const offS = offById.get(id) as IRSymbol
        const onS = onById.get(id) as IRSymbol
        expect(onS.fingerprint.logic, `logic differs unexpectedly for ${id}`).toBe(
          offS.fingerprint.logic,
        )
      }
    } finally {
      await cleanup()
    }
  })
})

const baseServerConfig: LspServerConfig = {
  command: "mock-lsp",
  args: [],
  initializeTimeoutMs: 1000,
  requestTimeoutMs: 100,
  fileBudgetMs: 500,
  concurrency: 4,
  initializationOptions: {},
}

function indexById(symbols: readonly IRSymbol[]): Map<string, IRSymbol> {
  const out = new Map<string, IRSymbol>()
  for (const s of symbols) out.set(s.id, s)
  return out
}
