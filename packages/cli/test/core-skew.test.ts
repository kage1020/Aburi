import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runScan } from "../src"
import { populate } from "./stub-language"

vi.mock("@aburi/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aburi/core")>()
  return {
    ...actual,
    scan: async (input: Parameters<typeof actual.scan>[0]) => {
      const { undeclaredVocab: _, ...older } = await actual.scan(input)
      return older
    },
  }
})

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-core-skew-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runScan against an @aburi/core that reports no undeclared vocabulary", () => {
  it("names the package that is behind instead of failing on the missing list", async () => {
    await populate(scratch, ["ok.stub"])
    await expect(
      runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" }),
    ).rejects.toMatchObject({
      code: "runtime-error",
      message: expect.stringContaining("@aburi/core is older than this @aburi/cli"),
    })
  })
})
