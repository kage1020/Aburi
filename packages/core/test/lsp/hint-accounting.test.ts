import type { LspEnrichmentStats, SymbolId } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import { resolveCallGraph } from "../../src/callgraph"
import { type EnrichmentResult, enrichWithLsp } from "../../src/lsp"
import { makeSymbol } from "../fixtures/ir"
import { makeClassSymbol, makeEnrichmentInput, makeMethodSymbol } from "./fixtures/enrichment-ctx"
import { mockServerFactory } from "./fixtures/mock-server"

const HOVER_METHOD = "textDocument/hover"
const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"

/**
 * lsp-enrichment.md §7.2 / §11.7 (LE24..LE27). Every counter above the hint block describes a
 * *request*, and a hover that answers on time with nothing this pass can use is a healthy row
 * in all of them. These cases pin the five places a hint is lost so that a run whose typed
 * tier bought nothing cannot read like one whose server had nothing to say.
 */
describe("LSP hint accounting (lsp-enrichment.md §7.2)", () => {
  it("counts a hint the pass wrote, and nothing else", async () => {
    const enrichment = await enrichThisFoo(() => ({
      contents: { kind: "markdown", value: "(method) C.foo(): void" },
    }))
    expect(enrichment.receiverHints.size).toBe(1)
    const stats = statsOf(enrichment)
    expect(stats.hintsProduced).toBe(1)
    expect(stats.hintsRejected).toEqual(noRejections())
  })

  // LE25
  it("counts a hover that answers nothing as an unparseable hover, not as a healthy request", async () => {
    const enrichment = await enrichThisFoo(() => null)
    const stats = statsOf(enrichment)
    expect(stats.hintsProduced).toBe(0)
    expect(stats.hintsRejected).toEqual(noRejections({ unparseableHover: 1 }))
    // The reason the counter has to exist: every other number says the run went well.
    expect(stats.requestsFailed).toBe(0)
    expect(stats.requestsTimedOut).toBe(0)
    expect(stats.filesEnriched).toBe(1)
    expect(stats.filesFellBack).toBe(0)
  })

  // LE25 — a payload arrived, but not one `extractHoverPayload` can read.
  it("counts a hover whose contents carry no text as an unparseable hover", async () => {
    const enrichment = await enrichThisFoo(() => ({ contents: { kind: "markdown" } }))
    const stats = statsOf(enrichment)
    expect(stats.hintsProduced).toBe(0)
    expect(stats.hintsRejected).toEqual(noRejections({ unparseableHover: 1 }))
  })

  // LE26
  it("counts hover text with no owner class in it as ownerClassNotFound", async () => {
    const enrichment = await enrichThisFoo(() => ({ contents: "function foo(): void" }))
    const stats = statsOf(enrichment)
    expect(stats.hintsProduced).toBe(0)
    expect(stats.hintsRejected).toEqual(noRejections({ ownerClassNotFound: 1 }))
  })

  // LE26
  it("counts hover text naming a class the Symbol table lacks as ownerClassNotFound", async () => {
    const enrichment = await enrichThisFoo(() => ({
      contents: "(method) Elsewhere.foo(): void",
    }))
    const stats = statsOf(enrichment)
    expect(stats.hintsProduced).toBe(0)
    expect(stats.hintsRejected).toEqual(noRejections({ ownerClassNotFound: 1 }))
  })

  // LE26
  it("counts a known class whose member is missing as memberNotFound", async () => {
    // `C` is in the table; `C.foo` is not — the shape of a method inherited from a
    // dependency the scan never read.
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, bar],
        fileContents: { "src/a.ts": FILE_WITH_THIS_FOO },
        serverFactory: hoverFactory(() => ({ contents: "(method) C.foo(): void" })),
      }),
    )
    const stats = statsOf(enrichment)
    expect(stats.hintsProduced).toBe(0)
    expect(stats.hintsRejected).toEqual(noRejections({ memberNotFound: 1 }))
  })

  // LE27
  it("counts a hint carrying the other receiver kind as kindMismatch and leaves the call unresolved", () => {
    const caller = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    const callee = makeMethodSymbol("src/a.ts", "Base", "foo", 2)
    const result = resolveCallGraph({
      symbols: [caller, callee],
      importsByFile: new Map(),
      receiverHints: new Map([
        [
          makeCallSiteKey("src/a.ts", 4, "this.foo"),
          { kind: "super" as const, targetSymbolId: callee.id },
        ],
      ]),
    })
    expect(result.lspHintUsage).toEqual({ consumed: 0, kindMismatch: 1, targetDropped: 0 })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics).toHaveLength(1)
  })

  // LE27
  it("counts a hint naming a dropped Symbol as targetDropped and leaves the call unresolved", () => {
    const caller = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    const callee = makeSymbol("ts:src/a.ts#C.foo", { kind: "method", dropped: true })
    const result = resolveCallGraph({
      symbols: [caller, callee],
      importsByFile: new Map(),
      receiverHints: new Map([
        [
          makeCallSiteKey("src/a.ts", 4, "this.foo"),
          { kind: "this" as const, targetSymbolId: callee.id },
        ],
      ]),
    })
    expect(result.lspHintUsage).toEqual({ consumed: 0, kindMismatch: 0, targetDropped: 1 })
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
  })

  it("counts a hint the resolver used", () => {
    const caller = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    const callee = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const result = resolveCallGraph({
      symbols: [caller, callee],
      importsByFile: new Map(),
      receiverHints: new Map([
        [
          makeCallSiteKey("src/a.ts", 4, "this.foo"),
          { kind: "this" as const, targetSymbolId: callee.id },
        ],
      ]),
    })
    expect(result.lspHintUsage).toEqual({ consumed: 1, kindMismatch: 0, targetDropped: 0 })
    expect(result.edges).toHaveLength(1)
  })

  it("leaves the hint counters at zero when the untyped tier got there first", () => {
    // A hint nothing had to consult is neither consumed nor rejected — the LSP tier only
    // sees the call sites every untyped tier missed (call-resolution.md §5.4).
    const callee = makeSymbol("ts:src/a.ts#helper", { kind: "function", name: "helper" })
    const caller = makeSymbol("ts:src/a.ts#caller", {
      kind: "function",
      name: "caller",
      calls: [{ target: "helper", line: 4, resolved: null }],
    })
    const result = resolveCallGraph({
      symbols: [caller, callee],
      importsByFile: new Map(),
      receiverHints: new Map([
        [
          makeCallSiteKey("src/a.ts", 4, "helper"),
          { kind: "this" as const, targetSymbolId: "ts:src/a.ts#Nope.foo" as SymbolId },
        ],
      ]),
    })
    expect(result.symbols[0]?.calls[0]?.resolved).toBe(callee.id)
    expect(result.lspHintUsage).toEqual({ consumed: 0, kindMismatch: 0, targetDropped: 0 })
  })

  // Both halves of the accounting over one line that holds two receivers. The key carries the
  // target (§10.1), so neither call borrows the other's hint — and the counters have to add up
  // per call site rather than per line for that to be visible.
  it("counts a hint and a consumption for each receiver on a shared line", async () => {
    const base = makeClassSymbol("src/a.ts", "Base", 1)
    const baseFoo = makeMethodSymbol("src/a.ts", "Base", "foo", 2)
    const sub = makeClassSymbol("src/a.ts", "Sub", 4)
    const subFoo = makeMethodSymbol("src/a.ts", "Sub", "foo", 5)
    const bar = makeMethodSymbol("src/a.ts", "Sub", "bar", 6, [
      { target: "super.foo", line: 7 },
      { target: "this.foo", line: 7 },
    ])
    // `this.foo(super.foo())` — one line, two receivers, two call sites.
    const line = "    this.foo(super.foo())"
    const content = `class Base {\n  foo() {}\n}\n\nclass Sub extends Base {\n  bar() {\n${line}\n  }\n  foo() {}\n}`
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [base, baseFoo, sub, subFoo, bar],
        fileContents: { "src/a.ts": content },
        serverFactory: hoverFactory((params) => ({
          contents:
            characterOf(params) === line.indexOf("this.") + "this.".length
              ? "(method) Sub.foo(): void"
              : "(method) Base.foo(): void",
        })),
      }),
    )
    expect(statsOf(enrichment).hintsProduced).toBe(2)
    expect(enrichment.receiverHints.size).toBe(2)

    const result = resolveCallGraph({
      symbols: enrichment.symbols,
      importsByFile: new Map(),
      receiverHints: enrichment.receiverHints,
      implementerHints: enrichment.implementerHints,
    })
    expect(result.lspHintUsage).toEqual({ consumed: 2, kindMismatch: 0, targetDropped: 0 })
    expect(result.edges.map((e) => e.to).sort()).toEqual([
      "ts:src/a.ts#Base.foo",
      "ts:src/a.ts#Sub.foo",
    ])
  })

  // LE28
  it("reports an all-rejected scan as all-rejected, identically on a rerun", async () => {
    const run = async (): Promise<LspEnrichmentStats> => {
      const enrichment = await enrichWithLsp(
        makeEnrichmentInput({
          symbols: [
            makeClassSymbol("src/a.ts", "C", 1),
            makeMethodSymbol("src/a.ts", "C", "bar", 3, [
              { target: "this.foo", line: 4 },
              { target: "this.foo", line: 5 },
            ]),
          ],
          fileContents: {
            "src/a.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.foo()\n  }\n}",
          },
          serverFactory: hoverFactory(async () => {
            // Nondeterministic wall-clock latency; the counts must not notice.
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)))
            return { contents: "(method) C.foo(): void" }
          }),
        }),
      )
      const stats = statsOf(enrichment)
      const result = resolveCallGraph({
        symbols: enrichment.symbols,
        importsByFile: new Map(),
        receiverHints: enrichment.receiverHints,
      })
      expect(result.lspHintUsage).toEqual({ consumed: 0, kindMismatch: 0, targetDropped: 0 })
      return stats
    }
    const first = await run()
    expect(first.hintsProduced).toBe(0)
    expect(first.hintsConsumed).toBe(0)
    expect(first.hintsRejected).toEqual(noRejections({ memberNotFound: 2 }))
    expect(await run()).toEqual(first)
  })
})

const FILE_WITH_THIS_FOO = "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}"

function noRejections(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    unparseableHover: 0,
    ownerClassNotFound: 0,
    memberNotFound: 0,
    kindMismatch: 0,
    targetDropped: 0,
    ...overrides,
  }
}

function hoverFactory(hover: (params: unknown) => unknown) {
  return mockServerFactory((_lang, client) => {
    client.installHandler(DOC_SYMBOL_METHOD, () => [])
    client.installHandler(HOVER_METHOD, hover)
  })
}

/** `class C { foo() {} bar() { this.foo() } }` enriched with one injected hover reply. */
async function enrichThisFoo(hover: (params: unknown) => unknown): Promise<EnrichmentResult> {
  return await enrichWithLsp(
    makeEnrichmentInput({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "foo", 2),
        makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }]),
      ],
      fileContents: { "src/a.ts": FILE_WITH_THIS_FOO },
      serverFactory: hoverFactory(hover),
    }),
  )
}

function statsOf(enrichment: EnrichmentResult): LspEnrichmentStats {
  const stats = enrichment.stats
  if (stats === undefined) throw new Error("expected the enrichment pass to report stats")
  return stats
}

function characterOf(params: unknown): number {
  const position = (params as { position?: { character?: number } }).position
  return position?.character ?? -1
}
