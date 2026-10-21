import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { clearListingFaults, useScratchWorkspace } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EXIT, IR_JSON_FILENAME } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig } from "./workspace"

const faults = await vi.hoisted(async () =>
  (await import("@aburi/test-support")).emptyListingFaults(),
)

vi.mock("node:fs", async (importOriginal) => {
  const { fsFailingOn } = await import("@aburi/test-support")
  return fsFailingOn(await importOriginal<typeof import("node:fs")>(), faults)
})

const workspace = useScratchWorkspace("unlisted-directory")

afterEach(() => clearListingFaults(faults))

const DECLARED = { components: [{ id: "app", roots: ["."] }] }

/** A manifest search that lists `src/locked` before any other walk does. */
type ManifestSearch = "nx" | "pnpm"

async function writeLockedWorkspace(
  config: Record<string, unknown>,
  search: ManifestSearch | null = null,
): Promise<string> {
  await workspace.writeSource("src/a.ts", "export function a() { return 1 }\n")
  await workspace.writeSource("src/locked/b.ts", "export function b() { return 1 }\n")
  if (search === "nx") {
    await workspace.writeSource("nx.json", "{}")
    await workspace.writeSource("src/locked/project.json", "{}")
  }
  if (search === "pnpm") {
    await workspace.writeSource("pnpm-workspace.yaml", 'packages:\n  - "src/*"\n')
    await workspace.writeSource("src/locked/package.json", '{ "name": "locked" }')
  }
  await writeConfig(workspace.root, { ...TYPESCRIPT, ...config })
  const locked = join(workspace.root, "src", "locked")
  faults.codes.set(locked, "EACCES")
  return locked
}

describe("a directory the scan cannot list", () => {
  it.each<[string, Record<string, unknown>, ManifestSearch | null, boolean]>([
    ["the component census", {}, null, true],
    ["the nx search", {}, "nx", true],
    ["a declared package pattern", {}, "pnpm", true],
    ["discovery", DECLARED, null, false],
  ])("ends aburi scan at exit 1 when %s meets it, naming it", async (_, config, search, resolving) => {
    const locked = await writeLockedWorkspace(config, search)

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain(`Directory "${locked}" could not be listed: EACCES`)
    expect(stderr.includes(`Failed to resolve components: Directory "${locked}"`)).toBe(resolving)
  })

  it.each<[string, ManifestSearch | null]>([
    ["the component census", null],
    ["the nx search", "nx"],
    ["a declared package pattern", "pnpm"],
  ])("ends aburi init at exit 1 when %s meets it, naming it", async (_, search) => {
    const locked = await writeLockedWorkspace({}, search)

    const { code, stderr } = await runCliIn(workspace.root, ["init", "--force"])

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain(
      `Failed to detect components: Directory "${locked}" could not be listed: EACCES`,
    )
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
    await writeConfig(workspace.root, { ...TYPESCRIPT, ...DECLARED })
    const build = join(workspace.root, "build")
    faults.codes.set(build, "EACCES")

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json", ...flags])

    expect(code, stderr).toBe(exit)
    expect(faults.refused).toContain(build)
  })
})
