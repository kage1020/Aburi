import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import type { SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { EXIT } from "../src"
import { type DocumentShape, symbolFor, writeScannedWorkspace } from "./ir-documents"
import { runCliIn } from "./run-cli"

const workspace = useScratchWorkspace("explain-cli")

const KEPT = symbolFor("ts:src/kept.ts#kept")
const ROUTE_LOST: SkippedFile = { path: "src/route.ts", reason: "parse-failed" }

async function explain(document: DocumentShape, ...argv: string[]) {
  await writeScannedWorkspace(workspace.root, document)
  return runCliIn(workspace.root, ["explain", ...argv, "--no-rescan"])
}

describe("aburi explain — what the user reads", () => {
  it("prints the answer on stdout", async () => {
    const { code, stdout, stderr } = await explain({ symbols: [KEPT] }, "kept")
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout).toContain("kept")
    expect(stdout.endsWith("\n")).toBe(true)
    expect(stderr).toBe("")
  })

  it("prints where it wrote the answer instead of the answer, under --output", async () => {
    const { code, stdout } = await explain({ symbols: [KEPT] }, "kept", "--output", "answer.md")
    const written = resolve(workspace.root, "answer.md")
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout).toBe(`→ ${written}\n`)
    expect(await readFile(written, "utf8")).toContain("kept")
  })

  it("lists the candidates of an ambiguous pattern and asks for the full id", async () => {
    const twice = symbolFor("ts:src/kept2.ts#keptTwice")
    const { code, stdout } = await explain({ symbols: [KEPT, twice] }, "kept")
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stdout).toBe(
      `Multiple matches for "kept":\n  ${KEPT.id}\n  ${twice.id}\n\nSpecify the full id to disambiguate.\n`,
    )
  })

  it("names the file a path asked about and why it was never analysed, with stdout empty", async () => {
    const { code, stdout, stderr } = await explain(
      { symbols: [KEPT], skipped: [ROUTE_LOST] },
      "src/route.ts",
    )
    expect(code).toBe(EXIT.GATE)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      'Cannot answer "src/route.ts": this IR never analysed src/route.ts (parse-failed), so it cannot say what that file declares.\n',
    )
  })

  it("says it was the id that named the file, not the question", async () => {
    const { code, stderr } = await explain(
      { symbols: [KEPT], skipped: [ROUTE_LOST] },
      "ts:src/route.ts#handleRequest",
    )
    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain("the file that id names")
  })

  it("says exactly No matches when the document covered everything", async () => {
    const { code, stderr } = await explain({ symbols: [KEPT] }, "handleRequest")
    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toBe('No matches for "handleRequest".\n')
  })

  it.each<[string, DocumentShape, string, string]>([
    [
      "names the losses in stats.skippedFiles",
      { symbols: [KEPT], skipped: [ROUTE_LOST] },
      "stats.skippedFiles",
      "predates",
    ],
    [
      "says it cannot name them when the document predates the list",
      { symbols: [KEPT], unnamedLosses: 1 },
      "predates",
      "names 1",
    ],
  ])("keeps No matches and counts the doubt under it when it %s", async (_, document, says, doesNotSay) => {
    const { code, stderr } = await explain(document, "handleRequest")
    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain('No matches for "handleRequest".')
    expect(stderr).toContain("1 file(s)")
    expect(stderr).toContain(says)
    expect(stderr).not.toContain(doesNotSay)
  })
})
