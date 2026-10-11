import { resolve } from "node:path"
import { errorFrom, makeSymbol, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError, readIR } from "../src"
import { documentWith } from "./ir-documents"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("ir-io")

const DOCUMENT = documentWith({ symbols: [makeSymbol({ id: "ts:src/a.ts#a", name: "a" })] })

async function refusalOf(contents: string | null): Promise<CliError> {
  const path = resolve(workspace.root, "aburi.ir.json")
  if (contents !== null) await writeFileAt(workspace.root, "aburi.ir.json", contents)
  return errorFrom(CliError, () => readIR(path))
}

function documentWithout(key: string): string {
  const document: Record<string, unknown> = { ...DOCUMENT }
  delete document[key]
  return JSON.stringify(document)
}

describe("readIR", () => {
  it("reads back a document it can trust", async () => {
    await writeFileAt(workspace.root, "aburi.ir.json", JSON.stringify(DOCUMENT))
    expect(await readIR(resolve(workspace.root, "aburi.ir.json"))).toEqual(DOCUMENT)
  })

  it.each([
    ["a file that is not there", null, "input-error", "Failed to read IR file"],
    ["text that is not JSON", "{ not json", "input-error", "is not valid JSON"],
    ["JSON that is not an object", "[]", "config-error", "is not an object at the root"],
    [
      "an object of another format",
      JSON.stringify({ ...DOCUMENT, $schema: "https://example.invalid/v2.json" }),
      "config-error",
      'has unexpected $schema "https://example.invalid/v2.json"; expected "https://aburi.kage1020.com/schema/aburi.ir.v1.json"',
    ],
  ])("refuses %s", async (_, contents, code, says) => {
    const refusal = await refusalOf(contents)
    expect(refusal.code).toBe(code)
    expect(refusal.message).toContain(resolve(workspace.root, "aburi.ir.json"))
    expect(refusal.message).toContain(says)
  })

  it.each([
    "workspace",
    "stats",
    "symbols",
    "components",
    "dependencies",
    "generator",
  ])("names a missing %s instead of failing on it later", async (key) => {
    const refusal = await refusalOf(documentWithout(key))
    expect(refusal.code).toBe("config-error")
    expect(refusal.message).toContain("failed integrity check")
    expect(refusal.message).toContain(key)
    expect(refusal.message).not.toContain("Cannot read properties")
  })

  it.each([
    ["symbols", {}],
    ["workspace", null],
    ["stats", 7],
  ])("names %s when it is present but the wrong type", async (key, value) => {
    const refusal = await refusalOf(JSON.stringify({ ...DOCUMENT, [key]: value }))
    expect(refusal.code).toBe("config-error")
    expect(refusal.message).toContain(key)
  })

  it("names the record and the field for a corruption inside a Symbol", async () => {
    const [symbol] = DOCUMENT.symbols
    const refusal = await refusalOf(
      JSON.stringify({ ...DOCUMENT, symbols: [{ ...symbol, fingerprint: undefined }] }),
    )
    expect(refusal.message).toContain("symbols[0]")
    expect(refusal.message).toContain("fingerprint")
    expect(refusal.message).not.toContain("Cannot read properties")
  })
})
