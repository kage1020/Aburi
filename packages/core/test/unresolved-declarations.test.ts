import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { detectManagers } from "../src/index"

/**
 * A manifest that declares package patterns and resolves none of them is a workspace whose
 * packages are all missing from the Document. It reaches the same single-project fallback as
 * a manifest that declared nothing, which is the right answer only for the second — so
 * detection reports which manifest it was, and the CLI says so.
 */

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

async function unresolved(): Promise<{ tool: string; patterns: string[] }[]> {
  const result = await detectManagers(tmp)
  return result.unresolved.map((entry) => ({ tool: entry.tool, patterns: [...entry.patterns] }))
}

describe("a manifest that declared packages and resolved none", () => {
  it("names the tool and the patterns", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "tools/*"\n')
    await mkdir(join(tmp, "packages", "dist"), { recursive: true })

    expect(await unresolved()).toEqual([{ tool: "pnpm", patterns: ["packages/*", "tools/*"] }])
  })

  it("counts a pattern the resolver drops as one that was declared", async () => {
    // An empty entry and a negation both resolve to nothing on their own, and both are
    // something the user wrote. Reporting only the patterns that reached the walk would be
    // silent about exactly the manifests most likely to be wrong.
    await write("pnpm-workspace.yaml", 'packages:\n  - ""\n  - "!packages/legacy"\n')

    expect(await unresolved()).toEqual([{ tool: "pnpm", patterns: ["", "!packages/legacy"] }])
  })

  it("says nothing about a manifest with no packages key", async () => {
    // pnpm reads that as "only the root package is included in the workspace", so the whole
    // repository as one component is the right answer rather than a missing one.
    await write("pnpm-workspace.yaml", "onlyBuiltDependencies: []\n")

    expect(await unresolved()).toEqual([])
  })

  it("says nothing about an empty packages list", async () => {
    // Measured with `pnpm ls -r`: an empty list and an absent key list the same one project.
    await write("pnpm-workspace.yaml", "packages: []\n")

    expect(await unresolved()).toEqual([])
  })

  it("says nothing about turbo, which declares no patterns of its own", async () => {
    // turbo's empty `roots` is deliberate — it is a co-marker — so it must not be read as a
    // declaration that failed.
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

  it("says nothing when every declaration resolved", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
    await writePackage("packages/app", "app")

    expect(await unresolved()).toEqual([])
  })
})
