import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fp, makeSymbol, useScratchWorkspace } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DIFF_FULL_MD_FILENAME, DIFF_MD_FILENAME, EXIT, runDiff } from "../src"
import { pathExists } from "../src/fs-probe"
import { diffDocuments, documentWith } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { writeIRs } from "./workspace"

const workspace = useScratchWorkspace("diff-max-bytes")

const KEPT = makeSymbol({ id: "ts:src/kept.ts#Kept", name: "Kept" })
const API_CHANGED = { ...KEPT, fingerprint: { ...fp("aaa"), api: "zzz000000000" } }

function added(count: number): IRSymbol[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `Added${String(i).padStart(4, "0")}`
    return makeSymbol({ id: `ts:src/${name}.ts#${name}`, name })
  })
}

const BASE = documentWith({ symbols: [KEPT] })

/** An API change and `count` additions: the change outranks the additions when a cap drops one. */
function headWith(count: number) {
  return documentWith({ symbols: [API_CHANGED, ...added(count)] })
}

const markdownBytes = async (path: string | null) =>
  Buffer.byteLength(await readFile(path ?? "", "utf8"), "utf8")

describe("aburi diff --max-bytes", () => {
  it("caps diff.md, writes the whole report beside it, and leaves diff.json whole", async () => {
    const { report: uncapped } = await diffDocuments(workspace.root, BASE, headWith(400))
    const full = await readFile(uncapped.diffMdPath ?? "", "utf8")
    expect(Buffer.byteLength(full, "utf8")).toBeGreaterThan(20_000)
    expect(full).toContain("## ⚠ API changes")
    expect(full).toContain("## ➕ Added")

    const { report } = await diffDocuments(workspace.root, BASE, headWith(400), { maxBytes: 2_000 })

    const markdown = await readFile(report.diffMdPath ?? "", "utf8")
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(2_000)
    expect(markdown).toContain("## ⚠ API changes")
    expect(markdown).not.toContain("## ➕ Added")
    expect(markdown).toContain("**Summary**: +400 added")
    expect(markdown).toContain("is `diff.full.md` beside `diff.md`.")
    expect(await readFile(report.diffJsonPath ?? "", "utf8")).toContain("Added0399")
    expect(report.diffFullMdPath).toBe(
      resolve(dirname(report.diffMdPath ?? ""), DIFF_FULL_MD_FILENAME),
    )
    expect(await readFile(report.diffFullMdPath ?? "", "utf8")).toBe(full)
  })

  it.each([
    ["a cap the report fits under", { maxBytes: 65_507 }],
    ["no cap", {}],
    ["no Markdown at all", { maxBytes: 2_000, format: "json" as const }],
  ])("removes an earlier diff.full.md on a run with %s", async (_, options) => {
    const { report: capped } = await diffDocuments(workspace.root, BASE, headWith(400), {
      maxBytes: 2_000,
    })
    expect(await pathExists(capped.diffFullMdPath ?? "")).toBe(true)

    const { report } = await diffDocuments(workspace.root, BASE, headWith(1), options)

    expect(report.diffFullMdPath).toBeNull()
    expect(await pathExists(capped.diffFullMdPath ?? "")).toBe(false)
  })

  it("warns, rather than fails, when a budget cannot be met", async () => {
    const { report, said } = await diffDocuments(
      workspace.root,
      documentWith({ symbols: [] }),
      documentWith({ symbols: added(20) }),
      { maxBytes: 10 },
    )
    const written = await markdownBytes(report.diffMdPath)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(written).toBeGreaterThan(10)
    expect(said).toContain(`${DIFF_MD_FILENAME} is ${written} bytes, over the 10 requested`)
    expect(await pathExists(report.diffFullMdPath ?? "")).toBe(true)
  })

  it("warns that it has nothing to cap under --format json", async () => {
    const { report, said } = await diffDocuments(workspace.root, BASE, headWith(1), {
      format: "json",
      maxBytes: 4_000,
    })
    expect(report.diffMdPath).toBeNull()
    expect(said).toContain("--max-bytes has no effect under --format json")
  })

  it("refuses a budget that is not a positive integer before reading either IR", async () => {
    const absent = resolve(workspace.root, "absent.json")
    await expect(
      runDiff({ cwd: workspace.root, base: absent, head: absent, maxBytes: 0 }),
    ).rejects.toMatchObject({
      code: "input-error",
      message: expect.stringContaining("--max-bytes"),
    })
  })
})

describe("aburi diff --max-bytes on the command line", () => {
  it("caps the diff.md the command writes", async () => {
    const { base, head } = await writeIRs(workspace.root, BASE, headWith(400))

    const { code } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      base,
      "--head",
      head,
      "--max-bytes",
      "2000",
    ])

    expect(code).toBe(EXIT.SUCCESS)
    expect(
      await markdownBytes(resolve(workspace.root, "out", DIFF_MD_FILENAME)),
    ).toBeLessThanOrEqual(2000)
  })

  it.each([
    "64kb",
    "0",
    "-1",
    "1.5",
    "",
  ])("refuses %j, which is not a plain byte count", async (value) => {
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      "./b.json",
      "--head",
      "./h.json",
      "--max-bytes",
      value,
    ])
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`--max-bytes must be a positive integer (got "${value}")`)
  })

  it("refuses a byte count too large to hold exactly", async () => {
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      "./b.json",
      "--head",
      "./h.json",
      "--max-bytes",
      "99999999999999999999",
    ])
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("--max-bytes is too large to be a byte count")
  })

  it("lists the flag in `diff --help`, which the action probes for", async () => {
    const { code, stdout } = await runCliIn(workspace.root, ["diff", "--help"])
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout).toContain("--max-bytes")
  })
})
