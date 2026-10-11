import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type { DiffResult, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME, EXIT, runDiff } from "../src"
import { commitAll, git, initRepository } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("diff-unknown-rename")

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

async function commitRename(basePadding: number, headPadding: number): Promise<void> {
  const root = workspace.root
  await initRepository(root)
  await writePackageJson(root, { name: "demo", private: true })
  await writeConfig(root, { ...TYPESCRIPT, maxFileSizeBytes: SIZE_CAP })
  await writeFileAt(root, "src/big.ts", billingClass() + padding(basePadding))
  await writeFileAt(root, "src/ping.ts", "export function ping(): number {\n  return 1\n}\n")
  await commitAll(root, "base")
  await git(["mv", "src/big.ts", "src/billing.ts"], root)
  await writeFileAt(root, "src/billing.ts", billingClass() + padding(headPadding))
  await commitAll(root, "head")
}

async function diffRenamed(failOn: string) {
  const outputDir = resolve(workspace.root, "out")
  const log = recordingLogger()
  const report = await runDiff({
    cwd: workspace.root,
    refSpec: "HEAD~1..HEAD",
    outputDir,
    failOn,
    warn: log.warn,
  })
  const json = JSON.parse(
    await readFile(resolve(outputDir, DIFF_JSON_FILENAME), "utf8"),
  ) as DiffResult
  const md = await readFile(resolve(outputDir, DIFF_MD_FILENAME), "utf8")
  return { report, json, md, said: log.warnings.join("\n") }
}

function unknownEntries(symbols: readonly SymbolChange[]) {
  return symbols.filter((change) => change.status === "unknown")
}

describe("aburi diff — a renamed file one scan skipped", () => {
  it("does not trip --fail-on removed when the head skipped the new path", async () => {
    await commitRename(0, 4)

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
    await commitRename(4, 0)

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
    await commitRename(4, 5)

    const { json, md, said } = await diffRenamed("removed")

    expect(json.notCompared).toStrictEqual([
      {
        path: "src/billing.ts",
        basePath: "src/big.ts",
        baseReason: "over-size",
        headReason: "over-size",
      },
    ])
    expect(md).toContain("- `src/big.ts` → `src/billing.ts` — over-size on both")
    expect(said).toContain(
      "1 file(s) were skipped by both scans; see notCompared[] in diff.json: src/big.ts → src/billing.ts.",
    )
  })
})
