import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type ListingFaults, useScratchWorkspace } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EXIT, IR_JSON_FILENAME } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig } from "./workspace"

const faults = vi.hoisted<ListingFaults>(() => ({ codes: new Map(), refused: new Set() }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const { readdirFailingOn } = await import("@aburi/test-support")
  return { ...actual, readdir: readdirFailingOn(actual, faults) }
})

const workspace = useScratchWorkspace("unlisted-directory")

afterEach(() => {
  faults.codes.clear()
  faults.refused.clear()
})

async function writeLockedWorkspace(config: Record<string, unknown>): Promise<string> {
  await workspace.writeSource("src/a.ts", "export function a() { return 1 }\n")
  await workspace.writeSource("src/locked/b.ts", "export function b() { return 1 }\n")
  await writeConfig(workspace.root, { ...TYPESCRIPT, ...config })
  const locked = join(workspace.root, "src", "locked")
  faults.codes.set(locked, "EACCES")
  return locked
}

describe("a directory the scan cannot list", () => {
  it.each([
    ["the component census", {}],
    ["discovery", { components: [{ id: "app", roots: ["."] }] }],
  ])("ends aburi scan at exit 1 when %s meets it, naming it", async (_, config) => {
    const locked = await writeLockedWorkspace(config)

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain(`Directory "${locked}" could not be listed`)
  })

  it("ends aburi init at exit 1, naming it", async () => {
    const locked = await writeLockedWorkspace({})

    const { code, stderr } = await runCliIn(workspace.root, ["init", "--force"])

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain(`Directory "${locked}" could not be listed`)
  })

  it("leaves aburi scan at exit 0 when .gitignore excludes it", async () => {
    const locked = await writeLockedWorkspace({})
    await workspace.writeSource(".gitignore", "locked/\n")

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(code, stderr).toBe(EXIT.SUCCESS)
    expect(faults.refused).toContain(locked)
    const ir = JSON.parse(
      await readFile(resolve(workspace.root, "out", IR_JSON_FILENAME), "utf8"),
    ) as IR
    expect(ir.symbols.map((symbol) => symbol.id)).toEqual(["ts:src/a.ts#a"])
  })

  it.each([
    ["honoured", [], EXIT.SUCCESS],
    ["not honoured", ["--no-respect-gitignore"], EXIT.RUNTIME],
  ])("in the nx search alone, git-ignored, exits as .gitignore is %s", async (_, flags, exit) => {
    await workspace.writeSource("src/a.ts", "export function a() { return 1 }\n")
    await workspace.writeSource("nx.json", "{}")
    await workspace.writeSource("build/project.json", "{}")
    await workspace.writeSource(".gitignore", "build/\n")
    await writeConfig(workspace.root, {
      ...TYPESCRIPT,
      components: [{ id: "app", roots: ["."] }],
    })
    const build = join(workspace.root, "build")
    faults.codes.set(build, "EACCES")

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json", ...flags])

    expect(code, stderr).toBe(exit)
    expect(faults.refused).toContain(build)
  })
})
