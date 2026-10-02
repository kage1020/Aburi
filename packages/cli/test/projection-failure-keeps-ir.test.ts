import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runScan } from "../src"
import { CliError } from "../src/errors"
import { writeTypeScriptWorkspace } from "./fixtures"

/**
 * The IR is what every page is derived from, so it is written before any of them. Written
 * last, it went down with the first Markdown page that threw: a component page too large to
 * assemble ended `aburi scan` with `workspace.md` on disk and no `aburi.ir.json`. A page fails
 * for real only past the line count `appendAll` names, so the projection is stood in for here.
 */

const FAILURE = "Maximum call stack size exceeded"

/** Which projection the stand-in makes throw; the other renders as it always does. */
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

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-projection-failure-"))
  await writeTypeScriptWorkspace(scratch, "projection-failure-fixture")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function written(): Promise<string[]> {
  return readdir(resolve(scratch, "out"))
}

describe("a Markdown projection that throws", () => {
  it("leaves the IR when the first page fails, because the IR is written before any page", async () => {
    failing.page = "workspace"

    await expect(runScan({ cwd: scratch })).rejects.toThrow(FAILURE)

    expect(await written()).toContain("aburi.ir.json")
    expect(await written()).not.toContain("workspace.md")
    const ir = JSON.parse(await readFile(resolve(scratch, "out", "aburi.ir.json"), "utf8"))
    expect(ir.components.length).toBeGreaterThan(0)
  })

  it("keeps the pages written before the one that failed", async () => {
    failing.page = "component"

    await expect(runScan({ cwd: scratch })).rejects.toThrow(FAILURE)

    expect(await written()).toContain("aburi.ir.json")
    expect(await written()).toContain("workspace.md")
  })

  it.each([
    ["workspace", "the workspace Markdown"],
    ["component", 'the Markdown for component "'],
  ] as const)("reports the %s page's failure as a bug in Aburi, naming the page", async (page, named) => {
    failing.page = page

    const error = await runScan({ cwd: scratch }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe("runtime-error")
    expect((error as CliError).message).toContain(`Internal error while rendering ${named}`)
    expect((error as CliError).message).toContain(FAILURE)
    expect((error as CliError).message).toContain("This is a bug in Aburi")
  })

  it("reports the scan's incidents before it ends the command", async () => {
    // `explain` trusts an IR it reads from disk to have had its incidents reported by the scan
    // that wrote it, and the IR is on disk.
    failing.page = "component"
    await writeFile(resolve(scratch, "src/broken.ts"), "export const a = (\n", "utf8")
    const warnings: string[] = []

    await expect(
      runScan({ cwd: scratch, incidents: { warn: (m: string) => warnings.push(m) } }),
    ).rejects.toThrow(FAILURE)

    expect(warnings).toContain("⚠ 1 file(s) had recoverable parse errors.")
  })
})
