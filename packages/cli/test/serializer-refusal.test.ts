import { readdir } from "node:fs/promises"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it, vi } from "vitest"
import { CliError, runDiff, runScan } from "../src"
import { documentWith } from "./ir-documents"
import { defaultOutput, writeIRs, writeTypeScriptWorkspace } from "./workspace"

const REFUSAL = "serializeCanonical at $.symbols[0]: keys render identically after NFC"

vi.mock("@aburi/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@aburi/core")>()
  return {
    ...core,
    serializeCanonical: () => {
      throw new core.CoreError(REFUSAL, { code: "canonical-key-collision" })
    },
  }
})

vi.mock("@aburi/diff", async (importOriginal) => {
  const diff = await importOriginal<typeof import("@aburi/diff")>()
  return {
    ...diff,
    writeCanonicalDiff: () => {
      throw new Error(REFUSAL)
    },
  }
})

const workspace = useScratchWorkspace("serializer-refusal")

describe("a document the serializer refuses", () => {
  it("is aburi scan's input error, naming the IR path and the refusal", async () => {
    await writeTypeScriptWorkspace(workspace.root, "serializer-fixture")

    const error = await errorFrom(CliError, () => runScan({ cwd: workspace.root, format: "json" }))

    expect(error.code).toBe("config-error")
    expect(error.message).toBe(
      `Failed to serialize the IR for ${defaultOutput(workspace.root, "aburi.ir.json")}: ${REFUSAL}`,
    )
  })

  it("leaves no pages beside an IR it refuses, under the default format", async () => {
    await writeTypeScriptWorkspace(workspace.root, "serializer-fixture")

    await errorFrom(CliError, () => runScan({ cwd: workspace.root }))

    expect(await readdir(defaultOutput(workspace.root))).toEqual([".gitignore"])
  })

  it("is aburi diff's input error the same way", async () => {
    const empty = documentWith({ symbols: [] })
    const { base, head } = await writeIRs(workspace.root, empty, empty)

    const error = await errorFrom(CliError, () =>
      runDiff({ cwd: workspace.root, base, head, format: "json", warn: () => {} }),
    )

    expect(error.code).toBe("config-error")
    expect(error.message).toBe(
      `Failed to serialize the diff for ${defaultOutput(workspace.root, "diff.json")}: ${REFUSAL}`,
    )
  })
})
