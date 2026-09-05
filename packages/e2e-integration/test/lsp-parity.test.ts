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
 * Hover-answering LSP mock: `documentSymbol` returns [], and `hover` answers
 * with the owner class of whatever the pass asked about — but only for the
 * positions the fixture's own `this.*` call sites occupy, so a pass that hovers
 * somewhere else gets nothing rather than a free pass. Records every hovered
 * position so a test can assert which requests were issued at all.
 */
function hoveringMockFactory(hovered: Array<{ line: number; character: number }>): ServerFactory {
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
      async request<T>(method: string, params: unknown): Promise<T | LspFailure> {
        if (method === "textDocument/documentSymbol") return [] as unknown as T
        if (method !== "textDocument/hover") return null as unknown as T
        const position = (params as { position: { line: number; character: number } }).position
        hovered.push({ line: position.line, character: position.character })
        // `service.ts:21` is `    this.helper()` — 0-based line 20, and column
        // 9 is where `findMethodColumn` puts the callee.
        if (position.line !== 20 || position.character !== 9) return null as unknown as T
        return { contents: "(method) Service.helper(): void" } as unknown as T
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
 * The receiver-hint key is an agreement between two packages' worth of code:
 * `enrichWithLsp` files a hint under `makeCallSiteKey(file, line, target)` and
 * `resolveCallGraph` reads it back with the same call. Both sides changed
 * together in the fix for #86, and both sides are exercised by core unit tests
 * that build the map themselves. This is the one place the real `scan` pipeline
 * carries a hint from the producer to the consumer, so a future edit to either
 * key site fails here rather than silently losing the LSP tier.
 */
describe("receiver hints survive the trip from enrichment to the resolver", () => {
  it("resolves `this.helper()` through a real scan, and declines `this.repo.save()`", async () => {
    const { root, cleanup } = await checkoutFixture("lsp-parity")
    try {
      const hovered: Array<{ line: number; character: number }> = []
      const on = await scanFixture(
        root,
        { lsp: { enabled: true, servers: { ts: baseServerConfig } } },
        {},
        [],
        hoveringMockFactory(hovered),
      )
      // `this.helper()` is the fixture's only two-segment `this.*` call site;
      // `this.repo.save()` and `this.repo.load()` are three-segment, and the
      // pass declines those because the position it would hover is the `repo`
      // property rather than the callee.
      expect(hovered).toEqual([{ line: 20, character: 9 }])

      const handle = on.ir.symbols.find((sym) => sym.id.endsWith("#Service.handle"))
      expect(handle).toBeDefined()
      const resolvedByTarget = new Map(
        (handle?.calls ?? []).map((call) => [call.target, call.resolved]),
      )
      expect(resolvedByTarget.get("this.helper")).toBe(
        on.ir.symbols.find((sym) => sym.id.endsWith("#Service.helper"))?.id,
      )
      expect(resolvedByTarget.get("this.repo.save")).toBeNull()
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
