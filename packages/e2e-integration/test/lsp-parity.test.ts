import type { LspClient, LspFailure, ServerFactory } from "@aburi/core"
import type { Symbol as IRSymbol, LspServerConfig } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { scanFixture } from "../src/scan-helper"

/**
 * Healthy in-memory LSP mock: satisfies initialize, returns [] for
 * documentSymbol, null for hover / typeDefinition / implementation. That is
 * "success with nothing to enrich" — the enrichment pass runs to completion
 * but produces no receiver hints or inferredThrows. Perfect for LE9 / LE12
 * parity where we prove that RUNNING enrichment with a working server does
 * not perturb api / syntax fingerprints.
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
 * `LspError`. That triggers per-request fallback on every call — enough to
 * exercise the fallback machinery under load without spawning a real process.
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
 * LE9-LE12 parity: the same fixture scanned with `lsp.enabled: false` vs `true`
 * MUST produce byte-identical `api` and `syntax` fingerprints for every Symbol.
 * `logic` may legitimately differ when LSP resolves calls into an effect
 * closure (LE11), so the test asserts the invariance ONLY on `api` and
 * `syntax`.
 *
 * We use an injected `serverFactory` that returns a minimal mock (documentSymbol
 * returns []; hover / typeDefinition / implementation return null). The mock
 * server IS a "healthy" server — no fallback fires — but it also refuses to
 * resolve any receiver, so no LSP-only edges appear. That is enough to prove
 * the byte-identity theorem: enabling LSP with a working server produces the
 * SAME api/syntax fingerprints as running with LSP off (§8 Theorem).
 */
describe("LSP parity (LE9-LE12)", () => {
  it("LE9/LE12: api + syntax fingerprints byte-identical under LSP off vs on (healthy server)", async () => {
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
      expect([...offById.keys()].sort()).toEqual([...onById.keys()].sort())
      for (const id of offById.keys()) {
        const offS = offById.get(id) as IRSymbol
        const onS = onById.get(id) as IRSymbol
        expect(onS.fingerprint.api, `api mismatch for ${id}`).toBe(offS.fingerprint.api)
        expect(onS.fingerprint.syntax, `syntax mismatch for ${id}`).toBe(offS.fingerprint.syntax)
        // signature.throws MUST NOT change; inferredThrows is a separate field.
        expect(onS.signature?.throws ?? []).toEqual(offS.signature?.throws ?? [])
      }
    } finally {
      await cleanup()
    }
  })

  it("LE10: api + syntax fingerprints byte-identical when LSP requests all error out", async () => {
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

  it("LE11: logic fingerprint MAY differ for symbols in an LSP-newly-resolved effect closure", async () => {
    // Sanity check: LSP-on scan without an actual effect closure must produce
    // logic fingerprints equal to LSP-off, since no propagated effects change
    // (fixture carries no db.write / event.publish yet). This is the boundary
    // guarantee — where `logic` byte-identity holds because no effect touches
    // the transitive closure.
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
        // No propagated effects in this fixture → logic MUST match too.
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
