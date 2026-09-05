import type { LspEnrichmentStats, LspHintRejections, SymbolId } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import { resolveCallGraph } from "../../src/callgraph"
import {
  type EnrichmentResult,
  enrichWithLsp,
  type LspProducerStats,
  withHintUsage,
} from "../../src/lsp"
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
    // A declined hint is reported like a call site that never had one — call-resolution.md
    // §8.1 leaves them in one bucket on purpose, and says the counters are where they part.
    expect(result.stats.unresolved.dynamic).toBe(1)
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
    expect(result.stats.unresolved.dynamic).toBe(1)
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

  // LE28. Every hint the pass produced is refused, so the run reports the shape the counters
  // exist for: work was done, nothing was bought. Asserted on the *merged* record, because
  // `hintsConsumed` and two of the buckets are zero in the producer half by construction —
  // reading them there would pass against a `withHintUsage` that did nothing.
  it("reports an all-rejected scan as all-rejected, identically on a rerun", async () => {
    const run = async (): Promise<LspEnrichmentStats> => {
      // The callee is in the Symbol table, so the pass hovers it and writes a hint; a drop
      // rule removed it, so the resolver refuses every one of those hints.
      const dropped = makeSymbol("ts:src/a.ts#C.foo", {
        kind: "method",
        name: "C.foo",
        dropped: true,
      })
      const enrichment = await enrichWithLsp(
        makeEnrichmentInput({
          symbols: [
            makeClassSymbol("src/a.ts", "C", 1),
            dropped,
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
      const result = resolveCallGraph({
        symbols: enrichment.symbols,
        importsByFile: new Map(),
        receiverHints: enrichment.receiverHints,
      })
      expect(result.stats.unresolved.dynamic).toBe(2)
      return withHintUsage(statsOf(enrichment), result.lspHintUsage)
    }

    const first = await run()
    expect(first.hintsProduced).toBe(2)
    expect(first.hintsConsumed).toBe(0)
    expect(first.hintsRejected).toEqual(noRejections({ targetDropped: 2 }))
    // The consumer sum, as a sum: every hint the pass produced was found and refused.
    expect(rejectedByResolver(first)).toBe(first.hintsProduced)
    expect(await run()).toEqual(first)
  })

  // The producer sum as a sum rather than a bucket at a time, over a run that reaches four
  // different outcomes. Pinning the buckets one by one fixes the record without fixing the
  // arithmetic between them, and the arithmetic is what lets a reader reconcile a real scan.
  it("accounts for every hover that came back, in exactly one place", async () => {
    const hovers: string[] = []
    const answers: Record<string, unknown> = {
      // `this.foo` — a callee the table has.
      "4": { contents: "(method) C.foo(): void" },
      // `this.gone` — owner class known, member not.
      "5": { contents: "(method) C.gone(): void" },
      // `this.foo` — the server has nothing to say here.
      "6": null,
      // `this.foo` — text, but nothing that names a class.
      "7": { contents: "function foo(): void" },
    }
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [
          makeClassSymbol("src/a.ts", "C", 1),
          makeMethodSymbol("src/a.ts", "C", "foo", 2),
          makeMethodSymbol("src/a.ts", "C", "bar", 3, [
            { target: "this.foo", line: 4 },
            { target: "this.gone", line: 5 },
            { target: "this.foo", line: 6 },
            { target: "this.foo", line: 7 },
          ]),
        ],
        fileContents: {
          "src/a.ts": [
            "class C {",
            "  foo() {}",
            "  bar() {",
            "    this.foo()",
            "    this.gone()",
            "    this.foo()",
            "    this.foo()",
            "  }",
            "}",
          ].join("\n"),
        },
        serverFactory: hoverFactory((params) => {
          const line = String(lineOf(params) + 1)
          hovers.push(line)
          return answers[line] ?? null
        }),
      }),
    )
    const stats = statsOf(enrichment)
    expect(hovers).toHaveLength(4)
    expect(stats.hintsProduced).toBe(1)
    expect(stats.hintsRejected).toEqual(
      noRejections({ memberNotFound: 1, unparseableHover: 1, ownerClassNotFound: 1 }),
    )
    // Every hover that came back is in exactly one of the four. Nothing else reads one, and
    // no counter in the IR carries this total — §7.2 says so, and this is where it is held.
    expect(stats.hintsProduced + rejectedByProducer(stats)).toBe(hovers.length)

    const result = resolveCallGraph({
      symbols: enrichment.symbols,
      importsByFile: new Map(),
      receiverHints: enrichment.receiverHints,
    })
    // The consumer sum over the same run: one call site found a hint at its key, and the
    // other three found none, so they are outside the identity rather than a zero in it.
    const merged = withHintUsage(stats, result.lspHintUsage)
    expect(merged.hintsConsumed).toBe(1)
    expect((merged.hintsConsumed ?? 0) + rejectedByResolver(merged)).toBe(
      countHintedCallSites(enrichment),
    )
  })

  it("folds the resolver's half in without disturbing the producer's", () => {
    // `withHintUsage` is the only path to a finished §7.2 record, and it adds rather than
    // assigns — so a second fold accumulates instead of overwriting.
    const producer = {
      ...EMPTY_STATS,
      hintsProduced: 7,
      hintsRejected: noRejections({ unparseableHover: 3 }),
    }
    const once = withHintUsage(producer, { consumed: 2, kindMismatch: 1, targetDropped: 4 })
    expect(once.hintsProduced).toBe(7)
    expect(once.hintsConsumed).toBe(2)
    expect(once.hintsRejected).toEqual(
      noRejections({ unparseableHover: 3, kindMismatch: 1, targetDropped: 4 }),
    )
    const twice = withHintUsage(
      { ...producer, ...once, hintsRejected: once.hintsRejected ?? noRejections() },
      { consumed: 1, kindMismatch: 0, targetDropped: 1 },
    )
    expect(twice.hintsConsumed).toBe(3)
    expect(twice.hintsRejected?.targetDropped).toBe(5)
    // The producer half is carried through untouched by either fold.
    expect(twice.hintsRejected?.unparseableHover).toBe(3)
  })
})

const FILE_WITH_THIS_FOO = "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}"

/**
 * Typed on `LspHintRejections` rather than `Record<string, number>`: a bucket renamed in the
 * schema has to fail the typecheck here, or these assertions would keep passing against names
 * the IR no longer carries.
 */
function noRejections(overrides: Partial<LspHintRejections> = {}): LspHintRejections {
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

function statsOf(enrichment: EnrichmentResult): LspProducerStats {
  const stats = enrichment.stats
  if (stats === undefined) throw new Error("expected the enrichment pass to report stats")
  return stats
}

/** The three buckets the enrichment pass can write — the producer side of §7.2's first sum. */
function rejectedByProducer(stats: LspEnrichmentStats): number {
  const r = stats.hintsRejected
  if (r === undefined) throw new Error("expected hintsRejected to be present")
  return r.unparseableHover + r.ownerClassNotFound + r.memberNotFound
}

/** The two buckets the resolver can write — the consumer side of §7.2's second sum. */
function rejectedByResolver(stats: LspEnrichmentStats): number {
  const r = stats.hintsRejected
  if (r === undefined) throw new Error("expected hintsRejected to be present")
  return r.kindMismatch + r.targetDropped
}

/**
 * Call sites that found a hint standing at their key — the right-hand side of the consumer
 * sum, which no counter in the IR carries. Recomputed here from the two things that decide
 * it, so the identity is checked against the input rather than against itself.
 */
function countHintedCallSites(enrichment: EnrichmentResult): number {
  let hinted = 0
  for (const symbol of enrichment.symbols) {
    for (const call of symbol.calls) {
      if (call.resolved !== null) continue
      if (enrichment.receiverHints.has(makeCallSiteKey(symbol.source.file, call.line, call.target)))
        hinted += 1
    }
  }
  return hinted
}

function characterOf(params: unknown): number {
  const position = (params as { position?: { character?: number } }).position
  return position?.character ?? -1
}

function lineOf(params: unknown): number {
  const position = (params as { position?: { line?: number } }).position
  return position?.line ?? -1
}

/** A `finalizeStats` record with the request counters at rest, for the fold tests. */
const EMPTY_STATS: LspProducerStats = {
  enabled: true,
  filesEnriched: 0,
  filesFellBack: 0,
  requestsIssued: 0,
  requestsTimedOut: 0,
  requestsFailed: 0,
  languagesDisabled: [],
  hintsProduced: 0,
  hintsConsumed: 0,
  hintsRejected: {
    unparseableHover: 0,
    ownerClassNotFound: 0,
    memberNotFound: 0,
    kindMismatch: 0,
    targetDropped: 0,
  },
}
