import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { DiffResult, SymbolChange } from "@aburi/types"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME } from "../src/artifact-paths"
import { realGit as git, probeRealGit } from "./fixtures"

let scratch = ""
let repository = ""
let gitProbeError: unknown = null

const SIZE_CAP = 1024

/** A class of six methods, about 800 bytes: under the cap until it is padded. */
function billingClass(): string {
  const methods = ["charge", "refund", "capture", "cancel", "preauthorize", "settle"].map(
    (name) =>
      `  ${name}(amount: number): number {\n` +
      `    if (amount <= 0) throw new Error("amount must be positive")\n` +
      `    return amount * 100\n` +
      `  }\n`,
  )
  return `export class Billing {\n${methods.join("\n")}}\n`
}

/** Lines that push a file past the cap and change nothing a scan would extract. */
function padding(lines: number): string {
  let text = ""
  for (let i = 1; i <= lines; i++) {
    text += `// padding line ${i}: pushes the file past maxFileSizeBytes and changes nothing else\n`
  }
  return text
}

async function commitAll(message: string): Promise<void> {
  await git(["add", "-A"], repository)
  await git(["commit", "-q", "-m", message], repository)
}

async function commitBase(basePadding: number): Promise<void> {
  await mkdir(resolve(repository, "src"), { recursive: true })
  await writeFile(resolve(repository, "package.json"), '{"name":"demo","private":true}\n', "utf8")
  await writeFile(
    resolve(repository, "aburi.json"),
    JSON.stringify({ languages: ["lang-typescript"], maxFileSizeBytes: SIZE_CAP }),
    "utf8",
  )
  await writeFile(resolve(repository, "src/big.ts"), billingClass() + padding(basePadding), "utf8")
  await writeFile(
    resolve(repository, "src/ping.ts"),
    "export function ping(): number {\n  return 1\n}\n",
    "utf8",
  )
  await commitAll("base")
}

/** The head commit: `git mv` to `src/billing.ts`, with `headPadding` lines of padding. */
async function commitRename(headPadding: number): Promise<void> {
  await git(["mv", "src/big.ts", "src/billing.ts"], repository)
  await writeFile(
    resolve(repository, "src/billing.ts"),
    billingClass() + padding(headPadding),
    "utf8",
  )
  await commitAll("head")
}

async function diffRenamed(failOn: string, warnings: string[] = []) {
  const outputDir = resolve(scratch, "out")
  const report = await runDiff({
    cwd: repository,
    refSpec: "HEAD~1..HEAD",
    outputDir,
    failOn,
    warn: (message) => warnings.push(message),
  })
  const json = JSON.parse(
    await readFile(resolve(outputDir, DIFF_JSON_FILENAME), "utf8"),
  ) as DiffResult
  const md = await readFile(resolve(outputDir, DIFF_MD_FILENAME), "utf8")
  return { report, json, md }
}

function unknownEntries(symbols: readonly SymbolChange[]) {
  return symbols.filter((change) => change.status === "unknown")
}

beforeAll(async () => {
  gitProbeError = await probeRealGit()
})

beforeEach(async () => {
  expect(gitProbeError, `git probe failed: ${String(gitProbeError)}`).toBeNull()
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-unknown-rename-"))
  repository = resolve(scratch, "demo")
  await mkdir(repository)
  await git(["init", "-q", "-b", "main"], repository)
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi diff — a renamed file one scan skipped", () => {
  it("does not trip --fail-on removed when the head skipped the new path", async () => {
    await commitBase(0)
    await commitRename(4)

    const { report, json, md } = await diffRenamed("removed")

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.triggered).toBeNull()
    expect(json.summary.removed).toBe(0)
    // The class and its six methods.
    const unknown = unknownEntries(json.symbols)
    expect(unknown).toHaveLength(7)
    for (const entry of unknown) {
      expect(entry).toMatchObject({
        absentFrom: "head",
        reason: "over-size",
        lostPath: "src/billing.ts",
      })
    }
    expect(md).toContain(
      "the head scan skipped this file under its head name, `src/billing.ts` (over-size), so this Symbol may still exist",
    )
  })

  it("does not trip --fail-on added when the base skipped the old path", async () => {
    await commitBase(4)
    await commitRename(0)

    const { report, json } = await diffRenamed("added")

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(json.summary.added).toBe(0)
    const unknown = unknownEntries(json.symbols)
    expect(unknown).toHaveLength(7)
    for (const entry of unknown) {
      expect(entry).toMatchObject({ absentFrom: "base", lostPath: "src/big.ts" })
    }
  })

  it("names a renamed file both scans skipped by both its paths", async () => {
    await commitBase(4)
    await commitRename(5)
    const warnings: string[] = []

    const { json, md } = await diffRenamed("removed", warnings)

    expect(json.notCompared).toStrictEqual([
      {
        path: "src/billing.ts",
        basePath: "src/big.ts",
        baseReason: "over-size",
        headReason: "over-size",
      },
    ])
    expect(md).toContain("- `src/big.ts` → `src/billing.ts` — over-size on both")
    expect(warnings.join("\n")).toContain(
      "1 file(s) were skipped by both scans; see notCompared[] in diff.json: src/big.ts → src/billing.ts.",
    )
  })
})
