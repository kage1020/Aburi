import { irSchemaViolations, useScratchWorkspace } from "@aburi/test-support"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { oneSymbolPerFile, scanStubs } from "../fixtures/plugins"

const workspace = useScratchWorkspace("test-files")

const TEST_CODE = [
  "e2e/checkout.stub",
  "packages/cli/tests/run.stub",
  "src/__fixtures__/ir.stub",
  "src/__mocks__/db.stub",
  "src/__tests__/order.stub",
  "src/order.spec.stub",
  "src/order.test-d.stub",
  "src/order.test.stub",
  "test/helpers.stub",
  "tools/.harness/test/run.stub",
]

const PRODUCTION_CODE = [
  "src/contest/entry.stub",
  "src/latest.stub",
  "src/order.stub",
  "src/testing.stub",
  "src/café/menu.stub",
]

async function scanOf(config: Config, language = oneSymbolPerFile()) {
  for (const file of [...TEST_CODE, ...PRODUCTION_CODE]) await workspace.writeSource(file, "x")
  const { ir } = await scanStubs(workspace.root, { config, languages: [language] })
  return ir
}

/** The files whose Symbol carries the key, and every value it carries. */
async function markedFiles(config: Config) {
  const marked = (await scanOf(config)).symbols.filter((symbol) => "inTestFile" in symbol)
  return {
    files: marked.map((symbol) => symbol.source.file).sort(),
    values: [...new Set(marked.map((symbol) => symbol.inTestFile))],
  }
}

describe("scan — the Symbols of test code", () => {
  it("are those of the files the default patterns name, dot directories included", async () => {
    expect(await markedFiles({})).toEqual({ files: TEST_CODE, values: [true] })
  })

  it.each([
    {
      testFiles: ["src/order.stub", "src/café/**"],
      files: ["src/café/menu.stub", "src/order.stub"],
    },
    {
      testFiles: ["test", "src/__mocks__/"],
      files: ["src/__mocks__/db.stub", "test/helpers.stub"],
    },
    { testFiles: ["**/test/**", "!tools"], files: ["test/helpers.stub"] },
    { testFiles: ["!tools/**"], files: [] },
    { testFiles: [], files: [] },
  ])("are those of the files $testFiles names in place of the default list", async ({
    testFiles,
    files,
  }) => {
    expect(await markedFiles({ testFiles })).toEqual({
      files,
      values: files.length === 0 ? [] : [true],
    })
  })

  it("include a dropped one, in a document the IR schema accepts", async () => {
    const language = oneSymbolPerFile({
      symbolDropHint: (symbol) =>
        symbol.source.file === "src/order.test.stub" ? { reason: "stub", category: "B" } : null,
    })
    const ir = await scanOf({}, language)
    const dropped = ir.symbols.filter((symbol) => symbol.dropped)

    expect(dropped.map(({ source, inTestFile }) => [source.file, inTestFile])).toEqual([
      ["src/order.test.stub", true],
    ])
    expect(irSchemaViolations(ir)).toEqual([])
  })

  it("keep every fingerprint they would have outside a test file", async () => {
    const fingerprints = async (config: Config) =>
      (await scanOf(config)).symbols.map((symbol) => [symbol.id, symbol.fingerprint])
    expect(await fingerprints({})).toEqual(await fingerprints({ testFiles: [] }))
  })
})
