import type { SkippedFile, UnrepresentableFile } from "@aburi/core"
import { makeLanguageId } from "@aburi/core"
import type { LspEnrichmentStats } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { ScanReport } from "../src"
import { incidentLinesFrom } from "./scan-report"

const NO_HINTS_REJECTED = {
  unparseableHover: 0,
  ownerClassNotFound: 0,
  memberNotFound: 0,
  kindMismatch: 0,
  targetDropped: 0,
}

function lsp(overrides: Partial<LspEnrichmentStats>): LspEnrichmentStats {
  return {
    enabled: true,
    filesEnriched: 10,
    filesFellBack: 0,
    languagesDisabled: [],
    requestsIssued: 10,
    requestsTimedOut: 0,
    requestsFailed: 0,
    ...overrides,
  }
}

function skippedFiles(
  count: number,
  reason: SkippedFile["reason"],
  path: (i: number) => string,
): ScanReport["skipped"] {
  return Array.from({ length: count }, (_, i) => ({ path: path(i), reason, detail: "detail" }))
}

function unspellable(fsPath: string, unnameablePrefix: string): UnrepresentableFile {
  return { fsPath, reason: "unspellable-name", unnameablePrefix }
}

describe("reportScanIncidents — what a scan with nothing to report says", () => {
  it("says nothing", () => {
    expect(incidentLinesFrom({ totalFiles: 3, parsedFiles: 3 })).toEqual([])
  })
})

describe("reportScanIncidents — the files that contributed no Symbols", () => {
  it("names every reason's files in the reason enum's order, with the detail the core wrote", () => {
    const lines = incidentLinesFrom({
      skipped: [
        { path: "src/route.ts", reason: "extraction-failed", detail: "plugin exploded" },
        { path: "src/x.weird", reason: "unroutable", detail: "no plugin claims it" },
        { path: "src/slow.ts", reason: "parse-timeout", detail: "ran past parseTimeoutMs" },
        { path: "vendor/bundle.js", reason: "over-size", detail: "2100000 > 1048576" },
        { path: "src/broken.ts", reason: "parse-failed", detail: "unexpected token at 3:7" },
        { path: "src/vanished.ts", reason: "unreadable", detail: "ENOENT" },
      ],
    })
    expect(lines[0]).toBe(
      "⚠ 6 file(s) contributed no Symbols: over-size=1, unreadable=1, unroutable=1, parse-failed=1, parse-timeout=1, extraction-failed=1",
    )
    expect(lines.filter((l) => l.startsWith("    "))).toEqual([
      "    vendor/bundle.js: 2100000 > 1048576",
      "    src/vanished.ts: ENOENT",
      "    src/x.weird: no plugin claims it",
      "    src/broken.ts: unexpected token at 3:7",
      "    src/slow.ts: ran past parseTimeoutMs",
      "    src/route.ts: plugin exploded",
    ])
  })

  it.each<[SkippedFile["reason"], string[], string[]]>([
    ["over-size", ["maxFileSizeBytes"], []],
    ["parse-timeout", ["parseTimeoutMs", "re-run", "Machine-dependent"], []],
    ["unreadable", ["re-run", "ends the run", "stopped being files"], ["permission"]],
    ["unroutable", ["plugin set", "renaming that segment"], []],
    ["parse-failed", ["refused", "Deterministic"], []],
    ["extraction-failed", ["threw"], []],
  ])("advises on %s with %j", (reason, says, doesNotSay) => {
    const group = incidentLinesFrom({ skipped: [{ path: "f", reason }] }).find((line) =>
      line.startsWith(`⚠ ${reason} (1) — `),
    )
    for (const fragment of says) expect(group).toContain(fragment)
    for (const fragment of doesNotSay) expect(group).not.toContain(fragment)
  })

  it.each([
    undefined,
    "",
  ])("lists a file whose detail is %j without a dangling separator", (detail) => {
    const lines = incidentLinesFrom({
      skipped: [
        detail === undefined
          ? { path: "src/quiet.ts", reason: "over-size" }
          : { path: "src/quiet.ts", reason: "over-size", detail },
      ],
    })
    expect(lines.at(-1)).toBe("    src/quiet.ts")
  })

  it("caps each reason's listing at ten, and leaves the tail unlabelled with the rest of it", () => {
    const skipped = skippedFiles(12, "extraction-failed", (i) => `src/f${i}.ts`)
    const lines = incidentLinesFrom({ skipped }, 'base ref "main"')
    expect(lines[0]).toBe(
      '⚠ base ref "main": 12 file(s) contributed no Symbols: extraction-failed=12',
    )
    expect(lines[1]).toContain('⚠ base ref "main": extraction-failed (12) — ')
    expect(lines.slice(2)).toEqual([
      ...skipped.slice(0, 10).map((s) => `    ${s.path}: detail`),
      "    …and 2 more",
    ])
  })

  it("says nothing about a tail when the cap is met exactly", () => {
    const lines = incidentLinesFrom({
      skipped: skippedFiles(10, "over-size", (i) => `vendor/big${i}.js`),
    })
    expect(lines.filter((l) => l.startsWith("    "))).toHaveLength(10)
    expect(lines.some((l) => l.startsWith("    …and"))).toBe(false)
  })

  it("gives each reason its own ten, so a flood cannot hide the one that gates", () => {
    const lines = incidentLinesFrom({
      skipped: [
        ...skippedFiles(11, "over-size", (i) => `vendor/big${i}.js`),
        { path: "src/route.ts", reason: "extraction-failed", detail: "boom" },
      ],
    })
    expect(lines).toContain("    …and 1 more")
    expect(lines).toContain("    src/route.ts: boom")
  })
})

describe("reportScanIncidents — the coverage gate", () => {
  it("puts the coverage line first, above the census that explains it", () => {
    const lines = incidentLinesFrom({
      totalFiles: 1200,
      skipped: skippedFiles(1200, "parse-failed", (i) => `src/f${i}.ts`),
      coverageFault: {
        kind: "nothing-parsed",
        totalFiles: 1200,
        dominant: "parse-failed",
        dominantCount: 1200,
      },
    })
    expect(lines[0]).toBe(
      "⚠ 1200 file(s) discovered, 0 parsed — 1200 as parse-failed. The IR is empty and will diff clean against any other empty IR.",
    )
    expect(lines[1]).toContain("1200 file(s) contributed no Symbols")
  })

  it.each([
    [899, 1000, 0.9, "899 of 1000 file(s) parsed (89%), below the minParsedFileRatio floor of 90%"],
    [199, 200, 1, "199 of 200 file(s) parsed (99%), below the minParsedFileRatio floor of 100%"],
    [
      902,
      1000,
      0.904,
      "902 of 1000 file(s) parsed (90%), below the minParsedFileRatio floor of 91%",
    ],
  ])("never prints %i of %i as reaching a floor of %d", (parsedFiles, totalFiles, floor, line) => {
    const lines = incidentLinesFrom({
      totalFiles,
      parsedFiles,
      coverageFault: { kind: "below-floor", parsedFiles, totalFiles, floor },
    })
    expect(lines).toEqual([
      `⚠ ${line}. Raise the coverage, or lower the floor if this is what the workspace looks like now.`,
    ])
  })

  it("labels the line like every other line it owns", () => {
    const lines = incidentLinesFrom(
      { coverageFault: { kind: "nothing-discovered" } },
      'base ref "main"',
    )
    expect(lines[0]).toContain('⚠ base ref "main": No file was discovered')
  })
})

describe("reportScanIncidents — files no Document path can name", () => {
  it("names what has to be renamed, once, however many files sit under it", () => {
    const lines = incidentLinesFrom({
      totalFiles: 3,
      parsedFiles: 3,
      unrepresentableFiles: [
        unspellable("src/v\\1/other.stub", "src/v\\1"),
        unspellable("src/v\\1/util.stub", "src/v\\1"),
        unspellable("odd\\name.stub", "odd\\name.stub"),
      ],
    })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("3 file(s) were left out of the IR and out of its counts")
    expect(lines[0]).toContain("under 2 name(s) with no spelling here")
    expect(lines[0]).toContain("write its backslash twice")
    expect(lines[0]).toContain("does not match itself")
    expect(lines.slice(1)).toEqual([
      "    odd\\name.stub",
      "    src/v\\1 — a directory, and the 2 file(s) under it",
    ])
  })

  it("puts them above the census that is recoverable from the IR", () => {
    const lines = incidentLinesFrom({
      totalFiles: 1,
      skipped: [{ path: "src/a.ts", reason: "over-size", detail: "big" }],
      unrepresentableFiles: [unspellable("odd\\name.ts", "odd\\name.ts")],
    })
    const unnameableAt = lines.findIndex((l) => l.includes("out of its counts"))
    expect(unnameableAt).toBeGreaterThanOrEqual(0)
    expect(lines.findIndex((l) => l.includes("contributed no Symbols"))).toBeGreaterThan(
      unnameableAt,
    )
  })

  it("does not cap the list, because nothing else holds a copy of it", () => {
    const lines = incidentLinesFrom({
      unrepresentableFiles: Array.from({ length: 12 }, (_, i) =>
        unspellable(`f${i}\\x.stub`, `f${i}\\x.stub`),
      ),
    })
    expect(lines).toHaveLength(13)
    expect(lines.join("\n")).not.toContain("more")
  })
})

describe("reportScanIncidents — LSP enrichment", () => {
  it.each<[string, Partial<LspEnrichmentStats>, string[]]>([
    [
      "reports fallbacks, disabled languages and the request census together",
      {
        filesEnriched: 8,
        filesFellBack: 2,
        languagesDisabled: [makeLanguageId("ts")],
        requestsIssued: 40,
        requestsTimedOut: 3,
        requestsFailed: 1,
      },
      [
        "⚠ LSP enrichment fell back for 2 file(s); IR field values in those files remain at the untyped tier.",
        "⚠ LSP disabled mid-run for language(s): ts.",
        "⚠ LSP requests: 40 issued · 3 timed out · 1 failed.",
      ],
    ],
    [
      "reports the request census alone when nothing fell back and no language was disabled",
      { requestsFailed: 2 },
      ["⚠ LSP requests: 10 issued · 0 timed out · 2 failed."],
    ],
    [
      "says what the typed tier bought on a run every other counter calls healthy",
      {
        hintsProduced: 0,
        hintsConsumed: 0,
        hintsRejected: {
          ...NO_HINTS_REJECTED,
          unparseableHover: 9,
          ownerClassNotFound: 2,
          memberNotFound: 1,
        },
      },
      ["⚠ LSP receiver hints: 0 produced · 0 resolved a call · 12 rejected."],
    ],
    [
      "reports a healthy typed tier too, as a census rather than an alarm",
      {
        hintsProduced: 30,
        hintsConsumed: 28,
        hintsRejected: { ...NO_HINTS_REJECTED, targetDropped: 2 },
      },
      ["⚠ LSP receiver hints: 30 produced · 28 resolved a call · 2 rejected."],
    ],
    [
      "stays quiet when the run neither produced nor refused a hint",
      { hintsProduced: 0, hintsConsumed: 0, hintsRejected: NO_HINTS_REJECTED },
      [],
    ],
  ])("%s", (_, stats, expected) => {
    expect(incidentLinesFrom({ lspEnrichment: lsp(stats) })).toEqual(expected)
  })

  it("labels every LSP line", () => {
    const lines = incidentLinesFrom({ lspEnrichment: lsp({ requestsFailed: 1 }) }, "head")
    expect(lines).toEqual(["⚠ head: LSP requests: 10 issued · 0 timed out · 1 failed."])
  })
})

describe("reportScanIncidents — the other incidents", () => {
  it("groups unreleased parse trees by plugin, and states what the leak costs", () => {
    const lines = incidentLinesFrom({
      treeReleaseFailures: [
        { plugin: "lang-stub", file: "a.ts", detail: "wasm heap is gone" },
        { plugin: "lang-stub", file: "b.ts", detail: "wasm heap is gone" },
        { plugin: "lang-other", file: "c.rs", detail: "releaseTree is a list, not a function" },
      ],
    })
    expect(lines).toEqual([
      "⚠ 3 parse tree(s) were not released by the plugin that built them. A tree a plugin does not free is not reclaimed by the garbage collector, so a long enough run exhausts the parser's heap.",
      "    lang-stub (2) — a.ts: wasm heap is gone",
      "    lang-other (1) — c.rs: releaseTree is a list, not a function",
    ])
  })

  it("names the framework ids a plugin-named frameworks value stands for, ahead of the tree leaks", () => {
    const lines = incidentLinesFrom(
      {
        treeReleaseFailures: [{ plugin: "lang-stub", file: "a.ts", detail: "gone" }],
        pluginNamedFrameworks: [
          { component: "app", value: "acme-kit", frameworkIds: ["acme-rpc", "acme-web"] },
          { component: "web", value: "lang-typescript", frameworkIds: [] },
        ],
      },
      "head",
    )
    expect(lines.slice(0, 2)).toEqual([
      '⚠ head: Component "app" lists "acme-kit" in frameworks, which names a plugin, not a framework; the IR carries it as written. Write "acme-rpc" or "acme-web".',
      '⚠ head: Component "web" lists "lang-typescript" in frameworks, which names a plugin, not a framework; the IR carries it as written. That plugin provides no framework: remove it, or write the framework id the component is built on.',
    ])
    expect(lines[2]).toContain("parse tree(s) were not released")
  })

  it("names every file behind the recoverable-error count, uncapped and unlabelled", () => {
    const parseErrorFiles = Array.from({ length: 12 }, (_, i) => ({
      path: `src/c${i}.tsx`,
      detail: "3:5 — syntax error",
    }))
    const lines = incidentLinesFrom({ parseErrorFiles, parseErrorCount: 12 }, 'base ref "main"')
    expect(lines).toEqual([
      '⚠ base ref "main": 12 file(s) had recoverable parse errors.',
      ...parseErrorFiles.map((file) => `    ${file.path}: 3:5 — syntax error`),
    ])
  })

  it("names the effect-classify timeout budget", () => {
    expect(incidentLinesFrom({ timeoutCount: 4 })).toEqual([
      "⚠ 4 effect classification(s) hit the per-call timeout budget.",
    ])
  })

  it("names a config that sits below the workspace root, labelled like the rest", () => {
    const lines = incidentLinesFrom(
      { configSource: "/repo/apps/web/aburi.json", workspaceRoot: "/repo" },
      'base ref "main"',
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('⚠ base ref "main": Config /repo/apps/web/aburi.json sits below')
  })

  it("stays quiet about a config the caller pinned, however far from the root it is", () => {
    const lines = incidentLinesFrom({
      configSource: "/repo/aburi.json",
      workspaceRoot: "/tmp/aburi-worktree-x/base",
      configPinnedByCaller: true,
    })
    expect(lines).toEqual([])
  })
})
