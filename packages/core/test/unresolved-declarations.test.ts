import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CoreError, detectManagers } from "../src/index"

let tmp = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "aburi-core-unresolved-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function write(relativePath: string, body: string): Promise<void> {
  const path = join(tmp, relativePath)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, body, "utf8")
}

async function writePackage(relativeDir: string, name: string): Promise<void> {
  await write(join(relativeDir, "package.json"), JSON.stringify({ name }))
}

interface Reported {
  tool: string
  manifestPath: string
  patterns: string[]
}

async function unresolved(): Promise<Reported[]> {
  const result = await detectManagers(tmp)
  return result.unresolved.map((entry) => ({
    tool: entry.tool,
    manifestPath: entry.manifestPath,
    patterns: [...entry.patterns],
  }))
}

describe("a manifest that declared packages and resolved none", () => {
  it("names the manifest, the tool and the patterns", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "tools/*"\n')
    await mkdir(join(tmp, "packages", "dist"), { recursive: true })

    expect(await unresolved()).toEqual([
      { tool: "pnpm", manifestPath: "pnpm-workspace.yaml", patterns: ["packages/*", "tools/*"] },
    ])
  })

  it("counts a pattern the resolver drops as one that was declared", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - ""\n  - "!packages/legacy"\n')

    expect(await unresolved()).toEqual([
      { tool: "pnpm", manifestPath: "pnpm-workspace.yaml", patterns: ["", "!packages/legacy"] },
    ])
  })

  it("says nothing about a manifest with no packages key", async () => {
    await write("pnpm-workspace.yaml", "onlyBuiltDependencies: []\n")

    expect(await unresolved()).toEqual([])
  })

  it("says nothing about an empty packages list", async () => {
    // Measured with `pnpm ls -r`: an empty list and an absent key list the same one project.
    await write("pnpm-workspace.yaml", "packages: []\n")

    expect(await unresolved()).toEqual([])
  })

  it("says nothing about turbo, which declares no patterns of its own", async () => {
    await write("turbo.json", "{}")

    expect(await unresolved()).toEqual([])
  })

  it("says nothing about an nx workspace with no projects", async () => {
    // nx has no pattern list, so there is nothing here that was declared and lost.
    await write("nx.json", "{}")

    expect(await unresolved()).toEqual([])
  })

  it("names only the manifest that resolved nothing", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "tools/*"\n')
    await write("package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] }))
    await writePackage("apps/a", "a")

    const result = await detectManagers(tmp)

    expect(result.unresolved.map((entry) => entry.tool)).toEqual(["pnpm"])
    expect(result.workspaces.map((candidate) => candidate.relativeRoot)).toEqual(["apps/a"])
  })

  it("orders two dead manifests by tool rather than by which detector finished first", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "tools/*"\n')
    await write("package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] }))

    expect((await unresolved()).map((entry) => entry.tool)).toEqual(["npm", "pnpm"])
  })

  it("orders two dead manifests that spell one tool by the manifest", async () => {
    await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    await write("pnpm-workspace.yaml", 'packages:\n  - "tools/*"\n')
    await write("package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] }))

    expect(await unresolved()).toEqual([
      { tool: "pnpm", manifestPath: "package.json", patterns: ["apps/*"] },
      { tool: "pnpm", manifestPath: "pnpm-workspace.yaml", patterns: ["tools/*"] },
    ])
  })

  it("says nothing when every declaration resolved", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
    await writePackage("packages/app", "app")

    expect(await unresolved()).toEqual([])
  })
})

describe("a packages field that is not a list of patterns", () => {
  async function refused(): Promise<CoreError> {
    const thrown = await detectManagers(tmp).then(
      () => null,
      (error: unknown) => error,
    )
    expect(thrown).toBeInstanceOf(CoreError)
    expect((thrown as CoreError).code).toBe("workspace-manifest-malformed")
    return thrown as CoreError
  }

  it("refuses an entry the YAML read as a map", async () => {
    // A trailing colon on the entry — the most ordinary slip there is.
    await write("pnpm-workspace.yaml", "packages:\n  - tools/*:\n")

    expect((await refused()).message).toContain("entry 0 is an object, not a string")
  })

  it("refuses a packages field that is a scalar", async () => {
    await write("pnpm-workspace.yaml", 'packages: "tools/*"\n')

    const error = await refused()
    expect(error.message).toContain("is a string, not a list")
    expect(error.message).toContain("pnpm-workspace.yaml")
  })

  it("refuses a workspaces entry that is not a string", async () => {
    await write("package.json", JSON.stringify({ name: "root", workspaces: [42] }))

    expect((await refused()).message).toContain("entry 0 is a number, not a string")
  })

  it("refuses the object form of workspaces the same way", async () => {
    await write("package.json", JSON.stringify({ name: "root", workspaces: { packages: [42] } }))

    expect((await refused()).message).toContain("entry 0 is a number, not a string")
  })

  it("says nothing about a workspaces field that is absent", async () => {
    await write("package.json", JSON.stringify({ name: "root" }))
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
    await writePackage("packages/app", "app")

    expect(await unresolved()).toEqual([])
  })
})
