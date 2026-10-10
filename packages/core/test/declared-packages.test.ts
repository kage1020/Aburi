import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { detectComponents, detectManagers } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-declared")

async function pnpmRoots(): Promise<string[]> {
  const { workspaces } = await detectManagers(tree.root)
  return workspaces
    .filter((candidate) => candidate.managerTool === "pnpm")
    .map((candidate) => candidate.relativeRoot)
}

async function writeNonPackageDirectories(): Promise<void> {
  await tree.mkdir("src")
  await tree.mkdir("a/b/c/d")
}

describe("a declared package is the directory that holds the manifest", () => {
  it("resolves '.' to the workspace root, not to every directory under it", async () => {
    await tree.writePackage(".", { name: "root-pkg" })
    await tree.writePackage("packages/app", { name: "app" })
    await writeNonPackageDirectories()
    await tree.writePnpmWorkspace(".", "packages/*")

    expect(await pnpmRoots()).toEqual([".", "packages/app"])
  })

  it("reads a trailing slash as the same root", async () => {
    await tree.writePackage(".", { name: "root-pkg" })
    await writeNonPackageDirectories()
    await tree.writePnpmWorkspace("./")

    expect(await pnpmRoots()).toEqual(["."])
  })

  it("declares nothing for '.' when the root holds no manifest", async () => {
    await tree.writePackage("packages/app", { name: "app" })
    await writeNonPackageDirectories()
    await tree.writePnpmWorkspace(".")

    expect(await pnpmRoots()).toEqual([])
  })

  it("resolves a literal path to that directory alone, not to its subtree", async () => {
    await tree.writePackage("tools/build", { name: "build" })
    await tree.writePackage("tools/build/nested", { name: "nested" })
    await tree.writePnpmWorkspace("tools/build")

    expect(await pnpmRoots()).toEqual(["tools/build"])
  })

  it("passes over a matched directory that holds no manifest", async () => {
    await tree.writePackage("packages/app", { name: "app" })
    await tree.mkdir("packages/dist")
    await tree.writePnpmWorkspace("packages/*")

    expect(await pnpmRoots()).toEqual(["packages/app"])
  })

  it("honours a negated pattern", async () => {
    await tree.writePackage("packages/app", { name: "app" })
    await tree.writePackage("packages/skipme", { name: "skipme" })
    await tree.writePnpmWorkspace("packages/*", "!packages/skipme")

    expect(await pnpmRoots()).toEqual(["packages/app"])
  })

  it("passes over a directory that is itself named package.json", async () => {
    await tree.writePackage("packages/app", { name: "app" })
    await tree.writeSource("packages/weird/package.json/inner.txt", "x")
    await tree.writePnpmWorkspace("packages/*")

    expect(await pnpmRoots()).toEqual(["packages/app"])
  })

  it("passes over a dependency's own manifest", async () => {
    await tree.writePackage("packages/app", { name: "app" })
    await tree.writePackage("node_modules/left-pad", { name: "left-pad" })
    await tree.writePnpmWorkspace("**")

    expect(await pnpmRoots()).toEqual(["packages/app"])
  })

  it("reaches ten directory levels down and stops there", async () => {
    const deep = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("/")
    await tree.writePackage(deep, { name: "deep" })
    await tree.writePackage(`${deep}/l11`, { name: "past-the-ceiling" })
    await tree.writePnpmWorkspace("**")

    expect(await pnpmRoots()).toEqual([deep])
  })

  it("falls back to the whole repository when no matched directory holds a manifest", async () => {
    await tree.mkdir("packages/one")
    await tree.mkdir("packages/two")
    await tree.writePnpmWorkspace("packages/*")

    const { managers } = await detectManagers(tree.root)
    expect(managers).toEqual([{ tool: "pnpm", roots: [] }])

    const components = await detectComponents({ workspaceRoot: tree.root })
    expect(components).toHaveLength(1)
    expect(components[0]?.roots).toEqual(["."])
  })

  it("declares nothing for an empty pattern", async () => {
    await tree.writePackage("packages/app", { name: "app" })
    await tree.writePnpmWorkspace("")

    expect(await pnpmRoots()).toEqual([])
  })

  it("carries the matched manifest on every candidate", async () => {
    await tree.writePackage(".", { name: "root-pkg" })
    await tree.writePackage("packages/app", { name: "app" })
    await tree.writePnpmWorkspace(".", "packages/*")

    const { workspaces } = await detectManagers(tree.root)
    expect(workspaces.map((candidate) => basename(candidate.manifestPath))).toEqual([
      "package.json",
      "package.json",
    ])
  })

  it("applies the same rule to npm workspaces", async () => {
    await writeNonPackageDirectories()
    await tree.writeJson("package.json", { name: "root-pkg", workspaces: [".", "apps/*"] })
    await tree.writePackage("apps/a", { name: "a" })

    const { workspaces } = await detectManagers(tree.root)
    expect(workspaces.map((candidate) => candidate.relativeRoot)).toEqual([".", "apps/a"])
  })
})

describe("the workspace root as a declared component", () => {
  it("becomes one component beside the packages, not one per directory", async () => {
    await tree.writePackage(".", { name: "root-pkg" })
    await tree.writePackage("packages/app", { name: "app" })
    await writeNonPackageDirectories()
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writeLanguageFiles("packages/app/src", ".ts")
    await tree.writePnpmWorkspace(".", "packages/*")

    const components = await detectComponents({ workspaceRoot: tree.root })

    expect(components.map((c) => c.id)).toEqual(["app", "root-pkg"])
    expect(components.find((c) => c.id === "root-pkg")?.roots).toEqual(["."])
  })

  it("censuses the root's own files", async () => {
    await tree.writePackage(".", { name: "root-pkg" })
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writePnpmWorkspace(".")

    const components = await detectComponents({ workspaceRoot: tree.root })

    expect(components).toHaveLength(1)
    expect(components[0]?.languages).toEqual(["ts"])
  })

  it("censuses the packages nested under it as its own subtree", async () => {
    await tree.writePackage(".", { name: "root-pkg" })
    await tree.writePackage("packages/app", { name: "app" })
    await tree.writeLanguageFiles("services", ".py")
    await tree.writeLanguageFiles("packages/app/src", ".ts")
    await tree.writePnpmWorkspace(".", "packages/*")

    const components = await detectComponents({ workspaceRoot: tree.root })

    expect(components.find((c) => c.id === "app")?.languages).toEqual(["ts"])
    expect(components.find((c) => c.id === "root-pkg")?.languages).toEqual(["py", "ts"])
  })

  it("names the root after its directory when the root manifest carries no name", async () => {
    await tree.writePackage("storefront", { private: true })
    await tree.writeSource("storefront/pnpm-workspace.yaml", 'packages:\n  - "."\n')

    const components = await detectComponents({ workspaceRoot: join(tree.root, "storefront") })

    expect(components).toHaveLength(1)
    expect(components[0]?.id).toBe("storefront")
    expect(components[0]?.roots).toEqual(["."])
  })
})
