import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CliError, EXIT, type ExitCode, runScan } from "../src"
import { runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"

const thrown = vi.hoisted(() => ({ error: null as unknown }))

vi.mock("@aburi/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aburi/core")>()),
  scan: async () => {
    throw thrown.error
  },
}))

const workspace = useScratchWorkspace("scan-errors")

beforeEach(async () => {
  await writeStubWorkspace(workspace.root, [])
})

const coded = (code: string) => Object.assign(new Error(`a fault coded ${code}`), { code })

describe("aburi scan — an error the core's scan throws", () => {
  it.each<[ExitCode, string, unknown, string]>([
    [EXIT.GATE, "vocab-undeclared", coded("vocab-undeclared"), "a fault coded vocab-undeclared"],
    [
      EXIT.GATE,
      "scan-plugin-misconfigured",
      coded("scan-plugin-misconfigured"),
      "a fault coded scan-plugin-misconfigured",
    ],
    [
      EXIT.GATE,
      "invalid-language-id",
      coded("invalid-language-id"),
      "a fault coded invalid-language-id",
    ],
    [
      EXIT.GATE,
      "a plain object coded vocab-undeclared",
      { code: "vocab-undeclared", message: "an undeclared value" },
      "an undeclared value",
    ],
    [
      EXIT.RUNTIME,
      "a registry code outside the plugin set",
      coded("duplicate-prefix"),
      "a fault coded duplicate-prefix",
    ],
    [EXIT.RUNTIME, "a read failure", coded("EACCES"), "a fault coded EACCES"],
    [EXIT.RUNTIME, "an error with no code", new Error("boom"), "boom"],
  ])("exits %i for %s, printing what was thrown", async (exit, _, error, says) => {
    thrown.error = error

    const { code, stdout, stderr } = await runCliIn(workspace.root, ["scan"])

    expect(code, stderr).toBe(exit)
    expect(stderr).toContain(says)
    expect(stderr).not.toContain("[object Object]")
    expect(stdout).toBe("")
  })
})

describe("runScan — an error the core's scan throws", () => {
  const scanWorkspace = () =>
    runScan({ cwd: workspace.root, outputDir: resolve(workspace.root, "out"), format: "json" })

  it("turns a fault in the plugin set into a plugin error caused by it", async () => {
    const fault = coded("invalid-language-id")
    thrown.error = fault

    const error = await errorFrom(CliError, scanWorkspace)

    expect(error.code).toBe("plugin-error")
    expect(error.cause).toBe(fault)
  })

  it("rethrows any other error as the same object", async () => {
    const fault = coded("EACCES")
    thrown.error = fault

    await expect(scanWorkspace()).rejects.toBe(fault)
  })
})
