import type { LspClient, LspFailure, ServerFactory } from "@aburi/core"
import type { Config, Symbol as IRSymbol, LspServerConfig } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { irValidator } from "../src/ir-schema"
import { scanFixture } from "../src/scan-helper"

const baseServerConfig: LspServerConfig = {
  command: "mock-lsp",
  args: [],
  initializeTimeoutMs: 1000,
  requestTimeoutMs: 100,
  fileBudgetMs: 500,
  concurrency: 4,
  initializationOptions: {},
}

const LSP_ON: Config = { lsp: { enabled: true, servers: { ts: baseServerConfig } } }

/** An in-memory LSP client whose lifecycle methods succeed and whose `request` is `request`. */
function mockServer(request: LspClient["request"]): ServerFactory {
  return () => ({
    async initialize() {
      return { capabilities: {} }
    },
    async didOpen() {
      return null
    },
    async didClose() {
      return null
    },
    request,
    async shutdown() {},
  })
}

/**
 * Healthy mock: returns [] for documentSymbol and null for hover. Enrichment runs to
 * completion — issuing documentSymbol per file — but resolves no receivers and adds no
 * inferred throws, which is the shape the fingerprint invariance needs to be proved against.
 */
const healthyMockFactory = (): ServerFactory =>
  mockServer(async (): Promise<never | LspFailure> => null as never)

/** Erroring mock: initialize succeeds but every request returns an `LspError`. */
const erroringMockFactory = (): ServerFactory =>
  mockServer(
    async (): Promise<never | LspFailure> => ({
      kind: "error",
      reason: "server-error",
      message: "injected",
    }),
  )

/**
 * Hover-answering mock: `documentSymbol` returns [], and `hover` answers with the owner class
 * — but only for the position the fixture's own `this.helper()` call site occupies, so a pass
 * that hovers somewhere else gets nothing rather than a free pass. Records every hovered
 * position so a test can assert which requests were issued at all.
 */
function hoveringMockFactory(hovered: Array<{ line: number; character: number }>): ServerFactory {
  return mockServer(async <T>(method: string, params: unknown): Promise<T | LspFailure> => {
    if (method === "textDocument/documentSymbol") return [] as unknown as T
    if (method !== "textDocument/hover") return null as unknown as T
    const position = (params as { position: { line: number; character: number } }).position
    hovered.push({ line: position.line, character: position.character })
    // `service.ts:21` is `    this.helper()` — 0-based line 20, and column 9 is where
    // `findMethodColumn` puts the callee.
    if (position.line !== 20 || position.character !== 9) return null as unknown as T
    return { contents: "(method) Service.helper(): void" } as unknown as T
  })
}

const fixture = useFixtureCheckout("lsp-parity")

const scanWithLsp = (factory: ServerFactory) => scanFixture(fixture.root, LSP_ON, {}, [], factory)

/** Symbols of both scans paired by id; the id sets must be identical. */
function pairById(off: readonly IRSymbol[], on: readonly IRSymbol[]): [IRSymbol, IRSymbol][] {
  const onById = new Map(on.map((symbol) => [symbol.id, symbol]))
  expect([...onById.keys()].sort()).toEqual(off.map((symbol) => symbol.id).sort())
  return off.map((symbol) => [symbol, onById.get(symbol.id) as IRSymbol])
}

/**
 * Fingerprint parity across LSP toggles. The theorem the LSP enrichment design commits to
 * is: for every Symbol S, `S.fingerprint.api` and `S.fingerprint.syntax` are byte-identical
 * between an LSP-off scan and an LSP-on scan of the same source tree. `S.fingerprint.logic`
 * may differ when LSP resolves a call whose transitive closure carries a classified effect —
 * but only then.
 */
describe("LSP fingerprint parity across enablement", () => {
  it("keeps api, syntax and logic fingerprints byte-identical when a healthy LSP server runs", async () => {
    const off = await scanFixture(fixture.root)
    const on = await scanWithLsp(healthyMockFactory())
    // Confirm the enrichment pass actually ran — otherwise this measures "LSP off vs LSP off
    // with an unused config".
    expect(on.ir.stats.lspEnrichment).toBeDefined()
    expect(on.ir.stats.lspEnrichment?.requestsIssued ?? 0).toBeGreaterThan(0)

    for (const [offSymbol, onSymbol] of pairById(off.ir.symbols, on.ir.symbols)) {
      const id = offSymbol.id
      expect(onSymbol.fingerprint.api, `api mismatch for ${id}`).toBe(offSymbol.fingerprint.api)
      expect(onSymbol.fingerprint.syntax, `syntax mismatch for ${id}`).toBe(
        offSymbol.fingerprint.syntax,
      )
      // No LSP-newly-resolved edge reaches a classified effect here, so logic holds too.
      expect(onSymbol.fingerprint.logic, `logic differs unexpectedly for ${id}`).toBe(
        offSymbol.fingerprint.logic,
      )
      // Signature.throws must not change; inferredThrows is a separate field.
      expect(onSymbol.signature?.throws ?? []).toEqual(offSymbol.signature?.throws ?? [])
    }
  })

  it("keeps api and syntax fingerprints byte-identical when every LSP request errors", async () => {
    const off = await scanFixture(fixture.root)
    const on = await scanWithLsp(erroringMockFactory())
    expect(on.ir.stats.lspEnrichment?.requestsFailed ?? 0).toBeGreaterThan(0)

    for (const [offSymbol, onSymbol] of pairById(off.ir.symbols, on.ir.symbols)) {
      expect(onSymbol.fingerprint.api).toBe(offSymbol.fingerprint.api)
      expect(onSymbol.fingerprint.syntax).toBe(offSymbol.fingerprint.syntax)
    }
  })
})

/**
 * The receiver-hint key is an agreement between two packages' worth of code: `enrichWithLsp`
 * files a hint under `makeCallSiteKey(file, line, target)` and `resolveCallGraph` reads it
 * back with the same call. Both sides are exercised by core unit tests that build the map
 * themselves; this is the one place the real `scan` pipeline carries a hint from the producer
 * to the consumer, so a future edit to either key site fails here rather than silently losing
 * the LSP tier.
 */
describe("receiver hints survive the trip from enrichment to the resolver", () => {
  it("resolves `this.helper()` through a real scan, and declines `this.repo.save()`", async () => {
    const hovered: Array<{ line: number; character: number }> = []
    const on = await scanWithLsp(hoveringMockFactory(hovered))
    // `this.helper()` is the fixture's only two-segment `this.*` call site; `this.repo.save()`
    // and `this.repo.load()` are three-segment, and the pass declines those because the
    // position it would hover is the `repo` property rather than the callee.
    expect(hovered).toEqual([{ line: 20, character: 9 }])

    const handle = on.ir.symbols.find((symbol) => symbol.id.endsWith("#Service.handle"))
    expect(handle).toBeDefined()
    const resolvedByTarget = new Map(
      (handle?.calls ?? []).map((call) => [call.target, call.resolved]),
    )
    expect(resolvedByTarget.get("this.helper")).toBe(
      on.ir.symbols.find((symbol) => symbol.id.endsWith("#Service.helper"))?.id,
    )
    expect(resolvedByTarget.get("this.repo.save")).toBeNull()
  })
})

/**
 * lsp-enrichment.md hint observability, through the whole pipeline rather than the pass alone. The
 * consumer half of the counters is written by the call resolver, which runs after enrichment
 * has returned and holds none of its state, so only a scan can show that both halves reach
 * `IR.stats`.
 */
describe("LSP hint counters in the scanned IR", () => {
  it("says the typed tier bought nothing when every hover answers empty", async () => {
    const on = await scanWithLsp(healthyMockFactory())
    const lsp = on.ir.stats.lspEnrichment
    expect(lsp?.hintsProduced).toBe(0)
    expect(lsp?.hintsConsumed).toBe(0)
    expect(lsp?.hintsRejected?.unparseableHover).toBe(1)
    // Everything else about this run reads as healthy, which is the point: without the
    // counters above, it is indistinguishable from one whose server had answers.
    expect(lsp?.requestsIssued ?? 0).toBeGreaterThan(0)
    expect(lsp?.requestsFailed).toBe(0)
    expect(lsp?.requestsTimedOut).toBe(0)
    expect(lsp?.filesFellBack).toBe(0)
  })

  it("reports a hint produced and consumed across the pass boundary", async () => {
    const on = await scanWithLsp(hoveringMockFactory([]))
    const lsp = on.ir.stats.lspEnrichment
    expect(lsp?.hintsProduced).toBe(1)
    // No untyped tier resolves a `this.` receiver, so the hint is the only thing that can
    // have resolved `this.helper()` — and `hintsConsumed` has to say so from the other side
    // of a pass boundary the enrichment stats do not cross on their own.
    expect(lsp?.hintsConsumed).toBe(1)
    expect(lsp?.hintsRejected).toEqual({
      unparseableHover: 0,
      ownerClassNotFound: 0,
      memberNotFound: 0,
      kindMismatch: 0,
      targetDropped: 0,
    })
  })

  it("emits a document ajv accepts, with the hint counters actually in it", async () => {
    // `ir-schema-conformance.test.ts` scans with LSP off, so `stats.lspEnrichment` — and with
    // it the whole `LspHintRejections` definition, its five required fields and its
    // `additionalProperties: false` — is never put in front of the validator there.
    const violations = await irValidator()
    const on = await scanWithLsp(hoveringMockFactory([]))
    expect(on.ir.stats.lspEnrichment?.hintsRejected).toBeDefined()
    expect(violations(on.ir)).toEqual([])
  })
})
