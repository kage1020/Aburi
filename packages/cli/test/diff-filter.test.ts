import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  dependency,
  fp,
  headings,
  sectionOf,
  symbolAt,
  useScratchWorkspace,
  withCallsTo,
} from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME, EXIT, runDiff } from "../src"
import { diffDocuments, documentWith } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { writeIRs } from "./workspace"

const workspace = useScratchWorkspace("diff-filter")

const TOTAL = symbolAt("src/total.ts", "total", 1, { fingerprint: fp("total") })
const RETOTALLED = { ...TOTAL, fingerprint: { ...fp("total"), logic: "zzz000000000" } }
const LEGACY = symbolAt("src/legacy.ts", "legacy", 1)
const CHECKOUT = withCallsTo(symbolAt("src/checkout.ts", "checkout", 1), [RETOTALLED, 2])

/** `checkout` added and calling `total`, whose logic changed, and `legacy` removed. */
const BASE = documentWith({ symbols: [TOTAL, LEGACY] })
const CHECKOUT_CALLS_TOTAL = dependency({ from: CHECKOUT.id, to: TOTAL.id, via: "call" })
const HEAD = documentWith({ symbols: [CHECKOUT, RETOTALLED], dependencies: [CHECKOUT_CALLS_TOTAL] })

const STATUSES = "added, removed, changed, moved, moved+changed, dropped-toggled, unknown"

const read = (path: string | null) => readFile(path ?? "", "utf8")

/** The warnings that name `--filter`, apart from the census warning a hand-built IR draws. */
function aboutTheFilter(warnings: readonly string[]): string[] {
  return warnings.filter((line) => line.includes("--filter"))
}

async function cli(base: IR, head: IR, ...flags: string[]) {
  const paths = await writeIRs(workspace.root, base, head)
  const run = await runCliIn(workspace.root, [
    "diff",
    "--base",
    paths.base,
    "--head",
    paths.head,
    ...flags,
  ])
  const outputs = resolve(workspace.root, "out")
  return {
    ...run,
    markdown: await read(resolve(outputs, DIFF_MD_FILENAME)),
    json: await read(resolve(outputs, DIFF_JSON_FILENAME)),
  }
}

describe("aburi diff --filter", () => {
  it("lists only the statuses named in diff.md, and leaves diff.json and the glyph line whole", async () => {
    const { report: unfiltered } = await diffDocuments(workspace.root, BASE, HEAD)
    const everyChange = await read(unfiltered.diffJsonPath)

    const { report, warnings } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "added,removed",
    })

    const markdown = await read(report.diffMdPath)
    expect(headings(markdown)).toEqual([
      "## 🧵 Slice View",
      "## ➕ Added",
      "## ➖ Removed",
      "## 🔗 Dependency changes",
    ])
    expect(markdown).toContain("**Summary**: +1 added · -1 removed · ~1 changed")
    expect(markdown).toContain(
      "> ℹ **Only `added` and `removed` changes are listed.** 1 other Symbol change is left out of this report; the Summary counts it.",
    )
    const sliceView = sectionOf(markdown, "## 🧵 Slice View").join("\n")
    expect(sliceView).toContain("`checkout`")
    expect(sliceView).toContain("`total`")
    expect(sectionOf(markdown, "## ➕ Added").filter((line) => line.startsWith("### "))).toEqual([
      "### `checkout` *(function)*",
    ])
    expect(await read(report.diffJsonPath)).toBe(everyChange)
    expect(report.summaryLine).toBe(unfiltered.summaryLine)
    expect(report.summaryLine).toBe("+1 -1 ~1 ↔0 ⤴0")
    expect(aboutTheFilter(warnings)).toEqual([])
  })

  it("caps the filtered report, and writes it uncapped beside it", async () => {
    const { report: uncapped } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "changed",
    })
    const filtered = await read(uncapped.diffMdPath)

    const { report } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "changed",
      maxBytes: Buffer.byteLength(filtered, "utf8") - 1,
    })

    expect(await read(report.diffFullMdPath)).toBe(filtered)
    expect(await read(report.diffMdPath)).toContain("> ℹ **Only `changed` changes are listed.**")
  })

  it("leaves the gate counting every change, and warns first that diff.md will not list what it counts", async () => {
    const { code, stderr, markdown } = await cli(
      BASE,
      HEAD,
      "--filter",
      "added",
      "--fail-on",
      "removed",
    )

    expect(code).toBe(EXIT.GATE)
    expect(markdown).not.toContain("## ➖ Removed")
    const warning =
      "⚠ --fail-on removed counts removed changes, which --filter leaves out of diff.md."
    expect(stderr).toContain(warning)
    expect(stderr.indexOf(warning)).toBeLessThan(stderr.indexOf("--fail-on removed tripped"))
  })

  it.each([
    ["added", "removed:duplicate", ["removed:duplicate counts removed"]],
    ["added", "removed:>3", ["removed:>3 counts removed"]],
    ["added", "removed,removed", ["removed counts removed"]],
    ["removed", "dropped-toggled:to-kept", ["dropped-toggled:to-kept counts dropped-toggled"]],
    ["added", "api-changed", ["api-changed counts changed and moved+changed"]],
    ["added,changed", "api-changed", []],
    ["moved+changed", "logic-changed", []],
    ["added", "added,unknown", ["unknown counts unknown"]],
  ])("under --filter %s, warns of --fail-on %s %j", async (filter, failOn, clauses) => {
    const { warnings } = await diffDocuments(workspace.root, BASE, HEAD, { filter, failOn })

    expect(aboutTheFilter(warnings)).toEqual(
      clauses.map(
        (clause) => `⚠ --fail-on ${clause} changes, which --filter leaves out of diff.md.`,
      ),
    )
  })

  it.each([
    ["", "it names no status"],
    [" , ", "it names no status"],
    ["added,", "segment 2 of 2 is empty"],
    ["added,,removed", "segment 2 of 3 is empty"],
    ["renamed", '"renamed" is no status.'],
    ["Added", '"Added" is no status.'],
    ["removed:duplicate", '"removed:duplicate" is a --fail-on token, not a status'],
    ["dropped-toggled:to-kept", '"dropped-toggled:to-kept" is a --fail-on token, not a status'],
  ])("refuses %j before reading either IR", async (filter, reason) => {
    const absent = resolve(workspace.root, "absent.json")

    const refusal = runDiff({ cwd: workspace.root, base: absent, head: absent, filter })

    await expect(refusal).rejects.toMatchObject({ code: "input-error" })
    await expect(refusal).rejects.toThrowError(`--filter value "${filter}" is invalid: ${reason}`)
    await expect(refusal).rejects.toThrowError(`The statuses are ${STATUSES}.`)
  })

  it("reads a status written twice, and spaces around the commas, as the statuses alone", async () => {
    const { report: plain } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "removed,added",
    })
    const once = await read(plain.diffMdPath)

    const { report } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: " added , removed,added ",
    })

    expect(await read(report.diffMdPath)).toBe(once)
  })

  it("warns that it has nothing to narrow under --format json", async () => {
    const { report, warnings } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "added",
      failOn: "removed:>3",
      format: "json",
    })

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.diffMdPath).toBeNull()
    expect(aboutTheFilter(warnings)).toEqual([
      "⚠ --filter has no effect under --format json: it narrows diff.md, which this run does not write, and diff.json holds every change.",
    ])
  })
})

describe("aburi diff --filter on the command line", () => {
  it("narrows the diff.md the command writes", async () => {
    const { code, stdout, markdown } = await cli(BASE, HEAD, "--filter", "removed")

    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout.split("\n")[0]).toBe("+1 -1 ~1 ↔0 ⤴0")
    expect(headings(markdown)).toEqual([
      "## 🧵 Slice View",
      "## ➖ Removed",
      "## 🔗 Dependency changes",
    ])
  })

  it("refuses an empty value with exit 2, naming the statuses", async () => {
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      "./b.json",
      "--head",
      "./h.json",
      "--filter",
      "",
    ])

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`--filter value "" is invalid: it names no status`)
    expect(stderr).toContain(`The statuses are ${STATUSES}.`)
  })

  it("lists the flag and the statuses in `diff --help`", async () => {
    const { code, stdout } = await runCliIn(workspace.root, ["diff", "--help"])

    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout).toContain("--filter <statuses>")
    expect(stdout.replace(/\s+/g, " ")).toContain(STATUSES)
  })
})

describe("aburi diff --quiet", () => {
  const LOST: IR = documentWith({
    symbols: [CHECKOUT, RETOTALLED],
    dependencies: [CHECKOUT_CALLS_TOTAL],
    skipped: [{ path: "src/legacy.ts", reason: "parse-failed" }],
  })

  it("prints the glyph line alone, and changes no artefact, stderr line or exit code", async () => {
    const gate = ["--fail-on", "unknown"]
    const loud = await cli(BASE, LOST, ...gate)
    const quiet = await cli(BASE, LOST, ...gate, "--quiet")

    expect(loud.stdout.split("\n").length).toBeGreaterThan(2)
    expect(quiet.stdout).toBe(`${loud.stdout.split("\n")[0]}\n`)
    expect(quiet.stdout).toMatch(/^\+1 -0 ~1 ↔0 ⤴0 · \?1 unknown\n$/)
    expect(quiet.code).toBe(EXIT.GATE)
    expect(quiet.code).toBe(loud.code)
    expect(quiet.stderr).toBe(loud.stderr)
    expect(quiet.markdown).toBe(loud.markdown)
    expect(quiet.json).toBe(loud.json)
  })
})
