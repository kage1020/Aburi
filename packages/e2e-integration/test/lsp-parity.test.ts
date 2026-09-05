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
      async didOpen() {
        return null
      },
      async didClose() {
        return null
      },
      async request(): Promise<never | LspFailure> {
        return null as never
      },
      async shutdown() {},
    }
    return client
  }
}

/**
 * Hovering LSP mock: answers `hover` the way tsserver answers over `this.helper()` in the
 * fixture's `Service`. The one call site whose receiver the enrichment pass can locate is that
 * one — `this.repo.save(x)` names its method on a property, not on `this` — so this is the
 * mock that gets a hint all the way through to an edge.
 */
function hoveringMockFactory(): ServerFactory {
  return () => {
    const client: LspClient = {
      async initialize() {
        return { capabilities: {} }
      },
      async didOpen() {
        return null
      },
      async didClose() {
        return null
      },
      async request(method: string): Promise<never | LspFailure> {
        if (method !== "textDocument/hover") return [] as never
        return { contents: "(method) Service.helper(): void" } as never
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
      async didOpen() {
        return null
      },
      async didClose() {
        return null
      },
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

/**
 * lsp-enrichment.md §7.2 / §11.7, through the whole pipeline rather than the pass alone. The
 * consumer half of the counters is written by the call resolver, which runs after enrichment
 * has returned, so only a scan can show that both halves reach `IR.stats`.
 */
describe("LSP hint counters in the scanned IR", () => {
  it("says the typed tier bought nothing when every hover answers empty", async () => {
    const { root, cleanup } = await checkoutFixture("lsp-parity")
    try {
      const on = await scanFixture(
        root,
        { lsp: { enabled: true, servers: { ts: baseServerConfig } } },
        {},
        [],
        healthyMockFactory(),
      )
      const lsp = on.ir.stats.lspEnrichment
      expect(lsp?.hintsProduced).toBe(0)
      expect(lsp?.hintsConsumed).toBe(0)
      expect(lsp?.hintsRejected?.unparseableHover ?? 0).toBeGreaterThan(0)
      // Everything else about this run reads as healthy, which is the point: without the
      // counters above, it is indistinguishable from one whose server had answers.
      expect(lsp?.requestsIssued ?? 0).toBeGreaterThan(0)
      expect(lsp?.requestsFailed).toBe(0)
      expect(lsp?.requestsTimedOut).toBe(0)
      expect(lsp?.filesFellBack).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it("reports produced, consumed and rejected hints from one scan", async () => {
    const { root, cleanup } = await checkoutFixture("lsp-parity")
    try {
      const on = await scanFixture(
        root,
        { lsp: { enabled: true, servers: { ts: baseServerConfig } } },
        {},
        [],
        hoveringMockFactory(),
      )
      const lsp = on.ir.stats.lspEnrichment
      expect(lsp?.hintsProduced).toBe(1)
      // No untyped tier resolves a `this.` receiver, so the hint is the only thing that can
      // have resolved this call — and the counter has to say so from the other side of a pass
      // boundary the enrichment stats do not cross on their own.
      expect(lsp?.hintsConsumed).toBe(1)
      expect(lsp?.hintsRejected).toEqual({
        unparseableHover: 0,
        ownerClassNotFound: 0,
        memberNotFound: 0,
        kindMismatch: 0,
        targetDropped: 0,
      })
      const handle = on.ir.symbols.find((s) => s.id.endsWith("#Service.handle"))
      expect(handle?.calls.find((c) => c.target === "this.helper")?.resolved).toBe(
        "ts:src/service.ts#Service.helper",
      )
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
