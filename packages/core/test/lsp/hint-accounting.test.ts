import type {
  Symbol as IRSymbol,
  LspEnrichmentStats,
  LspHintRejections,
  SourceRange,
  SymbolId,
} from "@aburi/types"
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
 * lsp-enrichment.md (LE24..LE27). Every counter above the hint block describes a
 * *request*, and a hover that answers on time with nothing this pass can use is a healthy row
 * in all of them. These cases pin the five places a hint is lost so that a run whose typed
 * tier bought nothing cannot read like one whose server had nothing to say.
 */
describe("LSP hint accounting (lsp-enrichment.md)", () => {
  it("counts a hint the pass wrote, and nothing else", async () => {
    const enrichment = await enrichThisFoo(() => ({
      contents: { kind: "markdown", value: "(method) C.foo(): void" },
    }))
    expect(enrichment.receiverHints.size).toBe(1)
    const stats = statsOf(enrichment)
    expect(stats.hintsProduced).toBe(1)
    expect(stats.hintsRejected).toEqual(noRejections())
  })

  it("writes a hint for a `#`-private member, which keeps its `#` in the Symbol table", async () => {
    // tsserver names the member `C.#v` in its hover, and `C.#v` is the Symbol's qualified name.
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [
          makeClassSymbol("src/a.ts", "C", 1),
          makeMethodSymbol("src/a.ts", "C", "#v", 2),
          makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.#v", line: 4 }]),
        ],
        fileContents: { "src/a.ts": "class C {\n  #v() {}\n  bar() {\n    this.#v()\n  }\n}" },
        serverFactory: hoverFactory(() => ({ contents: "(method) C.#v(): void" })),
      }),
    )
    expect(enrichment.receiverHints.size).toBe(1)
    expect(statsOf(enrichment).hintsRejected).toEqual(noRejections())
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

  // LE26a, LE26b
  describe("a class name the hover gives without its file", () => {
    const USERS = "src/users.ts"
    const LIB = "src/lib/repository.ts"
    const MODELS = "src/models/repository.ts"
    const ENTITIES = "src/entities/repository.ts"
    const HOVER = "(method) Repository.save(): string"
    // Two hops, the shape the lookup has to get right: the caller's file binds no
    // `Repository`, so it is free to declare one of its own.
    const CALLER =
      "class UserRepository extends BaseUserRepository {\n  create() {\n    return this.save()\n  }\n}"

    /** What a file declares, and the Symbols the scan reads out of that text. */
    interface Declarations {
      text: string
      symbols: IRSymbol[]
    }

    const at = (file: string, line: number): SourceRange => ({
      file,
      startLine: line,
      endLine: line,
      startColumn: null,
      endColumn: null,
    })

    /** `class Repository` with a `save`. */
    const repositoryIn = (file: string): Declarations => ({
      text: "class Repository {\n  save() {}\n}",
      symbols: [
        makeClassSymbol(file, "Repository", 1),
        makeMethodSymbol(file, "Repository", "save", 2),
      ],
    })

    /** A `class Repository` with no methods, which lang-typescript drops as a pure DTO. */
    const dtoIn = (file: string): Declarations => ({
      text: 'class Repository {\n  id = ""\n}',
      symbols: [
        makeSymbol(`ts:${file}#Repository`, {
          kind: "class",
          name: "Repository",
          dropped: true,
          dropReason: "pure DTO",
          source: at(file, 1),
        }),
      ],
    })

    /** `const Repository = { save }`, whose member gets the id a class's `save` would have. */
    const objectLiteralIn = (file: string): Declarations => ({
      text: 'const Repository = {\n  save: () => "local",\n}',
      symbols: [
        makeSymbol(`ts:${file}#Repository`, {
          kind: "const",
          name: "Repository",
          source: at(file, 1),
        }),
        makeSymbol(`ts:${file}#Repository.save`, {
          kind: "method",
          name: "Repository.save",
          source: at(file, 2),
        }),
      ],
    })

    /**
     * `UserRepository.create` in `src/users.ts` calls `this.save()`, and the server answers
     * that it is `Repository.save`. `own` is what `src/users.ts` declares above the caller, and
     * `others` is every other file, by path.
     */
    const enrichUsers = async (scenario: {
      own?: Declarations
      others?: Record<string, Declarations>
    }) => {
      const own = scenario.own
      const others = Object.entries(scenario.others ?? {})
      // The caller follows what is declared above it, after one blank line.
      const offset = own === undefined ? 0 : own.text.split("\n").length + 1
      const enrichment = await enrichWithLsp(
        makeEnrichmentInput({
          symbols: [
            ...(own?.symbols ?? []),
            makeClassSymbol(USERS, "UserRepository", 1 + offset),
            makeMethodSymbol(USERS, "UserRepository", "create", 2 + offset, [
              { target: "this.save", line: 3 + offset },
            ]),
            ...others.flatMap(([, declarations]) => declarations.symbols),
          ],
          fileContents: {
            ...Object.fromEntries(others.map(([file, declarations]) => [file, declarations.text])),
            [USERS]: own === undefined ? CALLER : `${own.text}\n\n${CALLER}`,
          },
          serverFactory: hoverFactory(() => ({ contents: HOVER })),
        }),
      )
      const key = makeCallSiteKey(USERS, 3 + offset, "this.save")
      return { hint: enrichment.receiverHints.get(key)?.targetSymbolId, stats: statsOf(enrichment) }
    }

    it("declines when two other files declare it, and counts it as ownerClassNotFound", async () => {
      // Two files declare it, so the old pass picked one — `src/lib/repository.ts`, the lower
      // id — rather than the class the caller extends.
      const { hint, stats } = await enrichUsers({
        others: { [LIB]: repositoryIn(LIB), [MODELS]: repositoryIn(MODELS) },
      })
      expect(hint).toBeUndefined()
      expect(stats.hintsProduced).toBe(0)
      expect(stats.hintsRejected).toEqual(noRejections({ ownerClassNotFound: 1 }))
    })

    it("takes the one class of that name in another file", async () => {
      const { hint, stats } = await enrichUsers({ others: { [MODELS]: repositoryIn(MODELS) } })
      expect(hint).toBe(`ts:${MODELS}#Repository.save`)
      expect(stats.hintsProduced).toBe(1)
      expect(stats.hintsRejected).toEqual(noRejections())
    })

    it("takes the caller's own file first, however many others declare the name", async () => {
      const { hint, stats } = await enrichUsers({
        own: repositoryIn(USERS),
        others: { [LIB]: repositoryIn(LIB), [MODELS]: repositoryIn(MODELS) },
      })
      expect(hint).toBe(`ts:${USERS}#Repository.save`)
      expect(stats.hintsProduced).toBe(1)
      expect(stats.hintsRejected).toEqual(noRejections())
    })

    it("stops at a class in the caller's own file even when it lacks the member", async () => {
      // An unrelated namesake, and the one `Repository` elsewhere does have `save`. The
      // caller's file is where the lookup ends, not merely where it starts.
      const { hint, stats } = await enrichUsers({
        own: { text: "class Repository {}", symbols: [makeClassSymbol(USERS, "Repository", 1)] },
        others: { [MODELS]: repositoryIn(MODELS) },
      })
      expect(hint).toBeUndefined()
      expect(stats.hintsProduced).toBe(0)
      expect(stats.hintsRejected).toEqual(noRejections({ memberNotFound: 1 }))
    })

    it.each<[string, Declarations]>([
      ["a const holding an object literal", objectLiteralIn(USERS)],
      [
        "an interface",
        {
          text: "interface Repository {\n  save(): string\n}",
          symbols: [
            makeSymbol(`ts:${USERS}#Repository`, {
              kind: "interface",
              name: "Repository",
              dropped: true,
              dropReason: "interface (data model)",
              source: at(USERS, 1),
            }),
          ],
        },
      ],
    ])("passes over %s of that name in the caller's own file", async (_what, own) => {
      const { hint, stats } = await enrichUsers({ own, others: { [MODELS]: repositoryIn(MODELS) } })
      expect(hint).toBe(`ts:${MODELS}#Repository.save`)
      expect(stats.hintsProduced).toBe(1)
      expect(stats.hintsRejected).toEqual(noRejections())
    })

    it("sets aside a dropped class that lacks the member when another class has the name", async () => {
      const { hint, stats } = await enrichUsers({
        others: { [ENTITIES]: dtoIn(ENTITIES), [MODELS]: repositoryIn(MODELS) },
      })
      expect(hint).toBe(`ts:${MODELS}#Repository.save`)
      expect(stats.hintsProduced).toBe(1)
      expect(stats.hintsRejected).toEqual(noRejections())
    })

    it("still takes a dropped class that lacks the member when it is the only one", async () => {
      const { hint, stats } = await enrichUsers({ others: { [ENTITIES]: dtoIn(ENTITIES) } })
      expect(hint).toBeUndefined()
      expect(stats.hintsRejected).toEqual(noRejections({ memberNotFound: 1 }))
    })

    it("counts a dropped class that holds the member, and declines", async () => {
      // A framework hint drops the class and leaves its methods, so `save` is still in the
      // table and this class is as likely to be the one meant as the live one.
      const LEGACY = "src/legacy/repository.ts"
      const legacy: Declarations = {
        text: "@AcmeInternal()\nclass Repository {\n  save() {}\n}",
        symbols: [
          makeSymbol(`ts:${LEGACY}#Repository`, {
            kind: "class",
            name: "Repository",
            decorators: [
              {
                name: "AcmeInternal",
                raw: "AcmeInternal()",
                arguments: [],
                boundary: false,
                line: 1,
              },
            ],
            dropped: true,
            dropReason: 'frameworkHints "acme": @AcmeInternal',
            source: at(LEGACY, 2),
          }),
          makeMethodSymbol(LEGACY, "Repository", "save", 3),
        ],
      }
      const { hint, stats } = await enrichUsers({
        others: { [LEGACY]: legacy, [MODELS]: repositoryIn(MODELS) },
      })
      expect(hint).toBeUndefined()
      expect(stats.hintsRejected).toEqual(noRejections({ ownerClassNotFound: 1 }))
    })

    // LE26b
    it("looks the member up in the file that declares the owner class, and nowhere else", async () => {
      // The owner class lacks `save`, and `src/other.ts` has a `Repository.save` of its own.
      const OTHER = "src/other.ts"
      const { hint, stats } = await enrichUsers({
        others: {
          [MODELS]: {
            text: "class Repository {}",
            symbols: [makeClassSymbol(MODELS, "Repository", 1)],
          },
          [OTHER]: objectLiteralIn(OTHER),
        },
      })
      expect(hint).toBeUndefined()
      expect(stats.hintsRejected).toEqual(noRejections({ memberNotFound: 1 }))
    })

    // LE26b
    it("builds the member's id from the owner class's id, not from its name", async () => {
      // ir-schema.md §3.1: nothing in the Document ties `name` to the qualified name in the id.
      const { hint } = await enrichUsers({
        own: {
          text: "class Repository {\n  save() {}\n}",
          symbols: [
            makeSymbol(`ts:${USERS}#Repository`, {
              kind: "class",
              name: "Repo",
              source: at(USERS, 1),
            }),
            makeMethodSymbol(USERS, "Repository", "save", 2),
          ],
        },
      })
      expect(hint).toBe(`ts:${USERS}#Repository.save`)
    })

    // LE26b
    it("keys the classes it looks for by the ids it holds, not by source.file", async () => {
      // The ids say `src/users.ts` and every `source.file` in that file says `src/views/users.ts`;
      // the two are not tied (`symbolIdFile`). The Symbol table is keyed by the ids.
      const VIEWS = "src/views/users.ts"
      const inViews = (symbol: IRSymbol): IRSymbol => ({
        ...symbol,
        source: { ...symbol.source, file: VIEWS },
      })
      const enrichment = await enrichWithLsp(
        makeEnrichmentInput({
          symbols: [
            ...repositoryIn(USERS).symbols.map(inViews),
            inViews(makeClassSymbol(USERS, "UserRepository", 5)),
            inViews(
              makeMethodSymbol(USERS, "UserRepository", "create", 6, [
                { target: "this.save", line: 7 },
              ]),
            ),
            ...repositoryIn(MODELS).symbols,
          ],
          fileContents: {
            [MODELS]: repositoryIn(MODELS).text,
            [VIEWS]: `${repositoryIn(USERS).text}\n\n${CALLER}`,
          },
          serverFactory: hoverFactory(() => ({ contents: HOVER })),
        }),
      )
      const key = makeCallSiteKey(VIEWS, 7, "this.save")
      expect(enrichment.receiverHints.get(key)?.targetSymbolId).toBe(`ts:${USERS}#Repository.save`)
    })
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
    // leaves them in one bucket on purpose, and says the counters are where they part.
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
    // sees the call sites every untyped tier missed (call-resolution.md).
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
  // target (a determinism rule), so neither call borrows the other's hint — and the counters
  // have to add up
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
    // no counter in the IR carries this total — the stats extension says so, and this is where
    // it is held.
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
    // `withHintUsage` is the only path to a finished `stats.lspEnrichment` record, and it adds
    // rather than
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

/** The three buckets the enrichment pass can write — the producer side of the first sum. */
function rejectedByProducer(stats: LspEnrichmentStats): number {
  const r = stats.hintsRejected
  if (r === undefined) throw new Error("expected hintsRejected to be present")
  return r.unparseableHover + r.ownerClassNotFound + r.memberNotFound
}

/** The two buckets the resolver can write — the consumer side of the second sum. */
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
