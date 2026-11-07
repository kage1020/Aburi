import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { call, errorFrom, makeSymbol, useScratchWorkspace } from "@aburi/test-support"
import type { CallResolutionStats, IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME, EXIT, FailOnParseError, runDiff } from "../src"
import { pathExists } from "../src/fs-probe"
import { diffDocuments, documentWith } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { filesUnder, writeEarlierReports, writeIRs } from "./workspace"

const workspace = useScratchWorkspace("diff-files")

const EMPTY = documentWith({ symbols: [] })
const FOO = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })
const ADDED_FOO = documentWith({ symbols: [FOO] })

function headWithCensus(callResolution: CallResolutionStats): IR {
  const unresolved = callResolution.totalCalls - callResolution.resolvedCalls
  const calls = Array.from({ length: unresolved }, (_, i) =>
    call({ target: `mystery${i}`, line: i + 2 }),
  )
  const head = documentWith({ symbols: [{ ...FOO, calls }] })
  return { ...head, stats: { ...head.stats, callResolution } }
}

describe("aburi diff --base/--head", () => {
  it("diffs two IR files and writes diff.json and diff.md", async () => {
    const { report } = await diffDocuments(workspace.root, EMPTY, ADDED_FOO)

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.diffJsonPath).toBe(resolve(workspace.root, "out", DIFF_JSON_FILENAME))
    expect(report.diffMdPath).toBe(resolve(workspace.root, "out", DIFF_MD_FILENAME))
    expect(await readFile(report.diffJsonPath ?? "", "utf8")).toMatch(/"added"\s*:\s*1/)
    expect(await readFile(report.diffMdPath ?? "", "utf8")).toContain("Added")
  })

  it("trips --fail-on and exits 3", async () => {
    const { report } = await diffDocuments(workspace.root, EMPTY, ADDED_FOO, { failOn: "added" })

    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.triggered).toEqual({
      clause: { token: "added", threshold: null },
      observed: 1,
      symbols: ["ts:src/a.ts#Foo"],
      scope: "all",
    })
  })

  it.each([[[]], [""]])(
    "refuses --fail-on %j, a gate with no clause, before it removes an earlier report",
    async (failOn) => {
      const earlier = await writeEarlierReports(workspace.root, ["out"])

      const error = await errorFrom(FailOnParseError, () =>
        runDiff({ cwd: workspace.root, base: "missing.json", head: "also.json", failOn }),
      )

      expect(error.message).toBe(
        '--fail-on value "" is invalid: expected at least one clause; an empty --fail-on value would silently disable the CI gate.',
      )
      expect(await filesUnder(workspace.root)).toEqual(earlier)
    },
  )

  it("names the tripped clause on stderr from the command line", async () => {
    const { base, head } = await writeIRs(workspace.root, EMPTY, ADDED_FOO)

    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      base,
      "--head",
      head,
      "--fail-on",
      "added",
    ])

    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain("--fail-on added tripped (observed: 1 added)")
  })

  it("leaves no earlier report behind when the run stops before it writes one", async () => {
    const { paths, report } = await diffDocuments(workspace.root, EMPTY, EMPTY)
    expect(await pathExists(report.diffMdPath ?? "")).toBe(true)

    const missing = resolve(workspace.root, "missing.json")
    await expect(runDiff({ cwd: workspace.root, base: paths.base, head: missing })).rejects.toThrow(
      `Failed to read IR file "${missing}"`,
    )
    expect(await pathExists(resolve(workspace.root, "out", DIFF_MD_FILENAME))).toBe(false)
    expect(await pathExists(resolve(workspace.root, "out", DIFF_JSON_FILENAME))).toBe(false)
  })

  it.each([
    ["md", [DIFF_MD_FILENAME]],
    ["json", [DIFF_JSON_FILENAME]],
  ] as const)(
    "leaves only what --format %s writes of an earlier capped report, beside the caller's own file",
    async (format, written) => {
      await workspace.writeSource("out/notes.md", "# Notes\n")
      const { report: capped } = await diffDocuments(workspace.root, EMPTY, ADDED_FOO, {
        maxBytes: 10,
      })
      expect(await pathExists(capped.diffFullMdPath ?? "")).toBe(true)

      await diffDocuments(workspace.root, EMPTY, ADDED_FOO, { format })

      expect((await readdir(resolve(workspace.root, "out"))).sort()).toEqual(
        [...written, "notes.md"].sort(),
      )
    },
  )
})

describe("aburi diff — the head's call-resolution census", () => {
  it.each([
    [
      {
        totalCalls: 3,
        resolvedCalls: 0,
        unresolved: { localScope: 0, external: 1, dynamic: 2, ambiguous: 0, noMatch: 0 },
      },
      "calls 3 · resolved 0 · unresolved 3 (external 1 · dynamic 2)",
    ],
    [
      {
        totalCalls: 0,
        resolvedCalls: 0,
        unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
      },
      "calls 0 · resolved 0 · unresolved 0",
    ],
  ])("renders %j", async (census, line) => {
    const { report } = await diffDocuments(workspace.root, EMPTY, headWithCensus(census))
    expect(report.callResolutionLine).toBe(line)
  })

  it("prints the line right after the summary", async () => {
    const head = headWithCensus({
      totalCalls: 1,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 1, noMatch: 0 },
    })
    const paths = await writeIRs(workspace.root, EMPTY, head)

    const { stdout } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      paths.base,
      "--head",
      paths.head,
    ])

    expect(stdout.split("\n").slice(0, 2)).toEqual([
      "+1 -0 ~0 ↔0 ⤴0",
      "calls 1 · resolved 0 · unresolved 1 (ambiguous 1)",
    ])
  })

  it("is unavailable for a head IR written before the census existed, and says why on stderr", async () => {
    const { report, said } = await diffDocuments(workspace.root, EMPTY, ADDED_FOO)
    expect(report.callResolutionLine).toBeNull()
    expect(said).toContain("head IR has no stats.callResolution")
  })

  it("prints nothing but the summary when the census is unavailable", async () => {
    const paths = await writeIRs(workspace.root, EMPTY, ADDED_FOO)

    const { stdout, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      paths.base,
      "--head",
      paths.head,
      "--format",
      "json",
    ])

    expect(stdout).toBe("+1 -0 ~0 ↔0 ⤴0\n")
    expect(stderr).toContain("no stats.callResolution")
  })
})

describe("aburi diff --base/--head over IRs made with different plugins", () => {
  const TS = {
    name: "lang-typescript",
    type: "lang",
    version: "0.6.0",
    grammarRevision: "tree-sitter-typescript@0.23.2",
  } as const
  const PRISMA = {
    name: "effects-prisma",
    type: "effects",
    version: "0.6.0",
    grammarRevision: null,
  } as const
  const madeWith = (...plugins: IR["generator"]["plugins"]): IR => ({
    ...EMPTY,
    generator: { ...EMPTY.generator, plugins },
  })
  const pluginLines = (said: string) =>
    said.split("\n").filter((line) => line.includes("different plugins"))

  it.each([
    [
      "a plugin only the base loaded",
      [TS, PRISMA],
      [TS],
      "effects-prisma 0.6.0 (effects) only in base",
    ],
    [
      "a plugin only the head loaded",
      [TS],
      [TS, PRISMA],
      "effects-prisma 0.6.0 (effects) only in head",
    ],
    [
      "another version and grammar of one plugin",
      [TS],
      [{ ...TS, version: "0.7.0", grammarRevision: "tree-sitter-typescript@0.24.0" }],
      "lang-typescript version 0.6.0 → 0.7.0, grammar tree-sitter-typescript@0.23.2 → tree-sitter-typescript@0.24.0",
    ],
  ])("names %s once, and diffs as it would without it", async (_, base, head, difference) => {
    const { report, said } = await diffDocuments(
      workspace.root,
      madeWith(...base),
      madeWith(...head),
    )

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(pluginLines(said)).toEqual([
      `⚠ The base and head IRs were made with different plugins: ${difference}. ` +
        "A Symbol whose effects, kind or role a plugin decides can be reported as changed for that alone. " +
        "Rescan both sides with one plugin set, or diff the two revisions (`aburi diff <base>..<head>`), which scans both with the head's plugins.",
    ])
  })

  it("lists every difference in one line, by plugin name", async () => {
    const NEST = {
      name: "framework-nestjs",
      type: "framework",
      version: "0.6.0",
      grammarRevision: null,
    } as const
    const { said } = await diffDocuments(
      workspace.root,
      madeWith(TS, PRISMA),
      madeWith({ ...TS, version: "0.7.0" }, NEST),
    )

    expect(pluginLines(said)).toHaveLength(1)
    expect(pluginLines(said)[0]).toContain(
      "effects-prisma 0.6.0 (effects) only in base; framework-nestjs 0.6.0 (framework) only in head; lang-typescript version 0.6.0 → 0.7.0.",
    )
  })

  it("says nothing when both list the same plugins, in any order", async () => {
    const { said } = await diffDocuments(workspace.root, madeWith(TS, PRISMA), madeWith(PRISMA, TS))

    expect(pluginLines(said)).toEqual([])
  })

  it("writes the line to stderr, and nothing of it to diff.json", async () => {
    const { base, head } = await writeIRs(workspace.root, madeWith(TS, PRISMA), madeWith(TS))

    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      base,
      "--head",
      head,
    ])

    expect(code).toBe(EXIT.SUCCESS)
    expect(pluginLines(stderr)).toHaveLength(1)
    expect(
      await readFile(resolve(workspace.root, "out", DIFF_JSON_FILENAME), "utf8"),
    ).not.toContain("effects-prisma")
  })
})
