import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it, vi } from "vitest"
import { CliError, runScan } from "../src"
import { writeStubWorkspace } from "./stub-language"

const olderCore = vi.hoisted(() => ({
  omits: "undeclaredVocab" as "undeclaredVocab" | "callResolution",
}))

vi.mock("@aburi/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aburi/core")>()
  return {
    ...actual,
    scan: async (input: Parameters<typeof actual.scan>[0]) => {
      const result = await actual.scan(input)
      if (olderCore.omits === "undeclaredVocab") {
        const { undeclaredVocab: _, ...older } = result
        return older
      }
      const { callResolution: __, ...stats } = result.ir.stats
      return { ...result, ir: { ...result.ir, stats } }
    },
  }
})

const workspace = useScratchWorkspace("core-skew")

describe("runScan against an @aburi/core older than this CLI", () => {
  it.each([
    ["undeclaredVocab", "@aburi/core is older than this @aburi/cli"],
    ["callResolution", "@aburi/core stopped emitting the call-resolution census"],
  ] as const)("names the package that is behind when scan() returns no %s", async (omits, says) => {
    olderCore.omits = omits
    await writeStubWorkspace(workspace.root, ["ok.stub"])

    const error = await errorFrom(CliError, () =>
      runScan({ cwd: workspace.root, outputDir: resolve(workspace.root, "out"), format: "json" }),
    )

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain(says)
  })
})
