import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CliError, IR_JSON_FILENAME, runScan, WORKSPACE_MD_FILENAME } from "../src"
import { writeTypeScriptWorkspace } from "./workspace"

const FAILURE = "Maximum call stack size exceeded"

const failing = vi.hoisted(() => ({ page: "component" as "workspace" | "component" }))

vi.mock("@aburi/markdown-projection", async (importOriginal) => {
  const projection = await importOriginal<typeof import("@aburi/markdown-projection")>()
  return {
    ...projection,
    projectWorkspace: (...args: Parameters<typeof projection.projectWorkspace>) => {
      if (failing.page === "workspace") throw new RangeError(FAILURE)
      return projection.projectWorkspace(...args)
    },
    projectComponent: (...args: Parameters<typeof projection.projectComponent>) => {
      if (failing.page === "component") throw new RangeError(FAILURE)
      return projection.projectComponent(...args)
    },
  }
})

const workspace = useScratchWorkspace("projection-failure")

beforeEach(async () => {
  await writeTypeScriptWorkspace(workspace.root, "projection-failure-fixture")
})

const written = () => readdir(resolve(workspace.root, "out"))

describe("a Markdown projection that throws", () => {
  it("leaves the IR when the first page fails, because the IR is written before any page", async () => {
    failing.page = "workspace"

    await expect(runScan({ cwd: workspace.root })).rejects.toThrow(FAILURE)

    expect(await written()).toContain(IR_JSON_FILENAME)
    expect(await written()).not.toContain(WORKSPACE_MD_FILENAME)
    const ir = JSON.parse(
      await readFile(resolve(workspace.root, "out", IR_JSON_FILENAME), "utf8"),
    ) as { components: unknown[] }
    expect(ir.components.length).toBeGreaterThan(0)
  })

  it("keeps the pages written before the one that failed", async () => {
    failing.page = "component"

    await expect(runScan({ cwd: workspace.root })).rejects.toThrow(FAILURE)

    expect(await written()).toEqual(
      expect.arrayContaining([IR_JSON_FILENAME, WORKSPACE_MD_FILENAME]),
    )
  })

  it.each([
    ["workspace", "the workspace Markdown"],
    ["component", 'the Markdown for component "projection-failure-fixture"'],
  ] as const)("reports the %s page's failure as a bug in Aburi, naming the page", async (page, named) => {
    failing.page = page

    const error = await errorFrom(CliError, () => runScan({ cwd: workspace.root }))

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain(`Internal error while rendering ${named}: ${FAILURE}`)
    expect(error.message).toContain("This is a bug in Aburi")
  })

  it("reports the scan's incidents before it ends the command", async () => {
    failing.page = "component"
    await workspace.writeSource("src/broken.ts", "export const a = (\n")
    const log = recordingLogger()

    await expect(runScan({ cwd: workspace.root, incidents: { warn: log.warn } })).rejects.toThrow(
      FAILURE,
    )

    expect(log.warnings).toContain("⚠ 1 file(s) had recoverable parse errors.")
  })
})
