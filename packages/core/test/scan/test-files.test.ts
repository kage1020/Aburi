import { useScratchWorkspace } from "@aburi/test-support"
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

async function scanOf(config: Config) {
  for (const file of [...TEST_CODE, ...PRODUCTION_CODE]) await workspace.writeSource(file, "x")
  const { ir } = await scanStubs(workspace.root, { config, languages: [oneSymbolPerFile()] })
  return ir.symbols
}

/** The files whose Symbol carries the key, and every value it carries. */
async function markedFiles(config: Config) {
  const marked = (await scanOf(config)).filter((symbol) => "inTestFile" in symbol)
  return {
    files: marked.map((symbol) => symbol.source.file).sort(),
    values: [...new Set(marked.map((symbol) => symbol.inTestFile))],
  }
}

describe("scan — the Symbols of test code", () => {
  it("are those of the files the default patterns name, dot directories included", async () => {
    expect(await markedFiles({})).toEqual({ files: TEST_CODE, values: [true] })
  })

  it("are those of the files `testFiles` names in their place, whichever normal form it writes", async () => {
    const config = { testFiles: ["src/order.stub", "src/café/**"] }
    expect(await markedFiles(config)).toEqual({
      files: ["src/café/menu.stub", "src/order.stub"],
      values: [true],
    })
  })

  it("are none under an empty `testFiles`", async () => {
    expect(await markedFiles({ testFiles: [] })).toEqual({ files: [], values: [] })
  })

  it("keep every fingerprint they would have outside a test file", async () => {
    const fingerprints = async (config: Config) =>
      (await scanOf(config)).map((symbol) => [symbol.id, symbol.fingerprint])
    expect(await fingerprints({})).toEqual(await fingerprints({ testFiles: [] }))
  })
})
