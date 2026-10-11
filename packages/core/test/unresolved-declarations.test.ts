import { errorFrom } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CoreError, detectManagers, type UnresolvedDeclaration } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-unresolved")

async function unresolved(): Promise<UnresolvedDeclaration[]> {
  return (await detectManagers(tree.root)).unresolved
}

const ROOT_WORKSPACES = JSON.stringify({ name: "root", workspaces: ["apps/*"] })

describe("a manifest that declared packages and resolved none", () => {
  it("names the manifest, the tool and the patterns", async () => {
    await tree.writePnpmWorkspace("packages/*", "tools/*")
    await tree.mkdir("packages/dist")

    expect(await unresolved()).toEqual([
      { tool: "pnpm", manifestPath: "pnpm-workspace.yaml", patterns: ["packages/*", "tools/*"] },
    ])
  })

  it("counts a pattern the resolver drops as one that was declared", async () => {
    await tree.writePnpmWorkspace("", "!packages/legacy")

    expect(await unresolved()).toEqual([
      { tool: "pnpm", manifestPath: "pnpm-workspace.yaml", patterns: ["", "!packages/legacy"] },
    ])
  })

  it("names only the manifest that resolved nothing", async () => {
    await tree.writePnpmWorkspace("tools/*")
    await tree.writeSource("package.json", ROOT_WORKSPACES)
    await tree.writePackage("apps/a", { name: "a" })

    const result = await detectManagers(tree.root)

    expect(result.unresolved.map((entry) => entry.tool)).toEqual(["pnpm"])
    expect(result.workspaces.map((candidate) => candidate.relativeRoot)).toEqual(["apps/a"])
  })

  it("orders two dead manifests by tool rather than by which detector finished first", async () => {
    await tree.writePnpmWorkspace("tools/*")
    await tree.writeSource("package.json", ROOT_WORKSPACES)

    expect((await unresolved()).map((entry) => entry.tool)).toEqual(["npm", "pnpm"])
  })

  it("orders two dead manifests that spell one tool by the manifest", async () => {
    await tree.writeSource("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    await tree.writePnpmWorkspace("tools/*")
    await tree.writeSource("package.json", ROOT_WORKSPACES)

    expect(await unresolved()).toEqual([
      { tool: "pnpm", manifestPath: "package.json", patterns: ["apps/*"] },
      { tool: "pnpm", manifestPath: "pnpm-workspace.yaml", patterns: ["tools/*"] },
    ])
  })
})

describe("nothing is reported for", () => {
  it.each<[string, Record<string, string>]>([
    [
      "a pnpm manifest with no packages key",
      { "pnpm-workspace.yaml": "onlyBuiltDependencies: []\n" },
    ],
    // Measured with `pnpm ls -r`: an empty list and an absent key list the same one project.
    ["an empty packages list", { "pnpm-workspace.yaml": "packages: []\n" }],
    ["turbo, which declares no patterns of its own", { "turbo.json": "{}" }],
    ["an nx workspace with no projects, since nx lists no patterns", { "nx.json": "{}" }],
    [
      "a package.json with no workspaces field",
      { "package.json": JSON.stringify({ name: "root" }) },
    ],
    [
      "a declaration that resolved",
      {
        "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
        "packages/app/package.json": JSON.stringify({ name: "app" }),
      },
    ],
  ])("%s", async (_title, files) => {
    for (const [rel, content] of Object.entries(files)) await tree.writeSource(rel, content)

    expect(await unresolved()).toEqual([])
  })
})

describe("a packages field that is not a list of patterns", () => {
  it.each([
    // A trailing colon on the entry — the most ordinary slip there is.
    ["pnpm-workspace.yaml", "packages:\n  - tools/*:\n", "entry 0 is an object, not a string"],
    ["pnpm-workspace.yaml", 'packages: "tools/*"\n', "is a string, not a list"],
    ["package.json", JSON.stringify({ workspaces: [42] }), "entry 0 is a number, not a string"],
    [
      "package.json",
      JSON.stringify({ workspaces: { packages: [42] } }),
      "entry 0 is a number, not a string",
    ],
  ])("refuses %s holding %j", async (file, content, fault) => {
    await tree.writeSource(file, content)

    const error = await errorFrom(CoreError, () => detectManagers(tree.root))

    expect(error.code).toBe("workspace-manifest-malformed")
    expect(error.message).toContain(fault)
    expect(error.message).toContain(file)
  })
})
