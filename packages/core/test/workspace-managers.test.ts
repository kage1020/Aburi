import { join } from "node:path"
import { errorFrom } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CoreError, detectManagers } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-workspace-managers")

describe("detectManagers", () => {
  it("resolves pnpm packages globs into workspace candidates", async () => {
    await tree.writePnpmWorkspace("apps/*")
    await tree.writePackage("apps/billing", { name: "billing" })
    await tree.writePackage("apps/pricing", { name: "pricing" })

    const result = await detectManagers(tree.root)

    expect(result.managers).toEqual([{ tool: "pnpm", roots: ["apps/billing", "apps/pricing"] }])
    expect(result.workspaces.map((w) => w.relativeRoot)).toEqual(["apps/billing", "apps/pricing"])
  })

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    [null, "npm"],
  ])("names package.json#workspaces after the lockfile beside it (%s)", async (lockfile, tool) => {
    await tree.writeJson("package.json", { name: "root", workspaces: ["apps/*"] })
    if (lockfile !== null) await tree.writeSource(lockfile, "")
    await tree.writePackage("apps/a", { name: "a" })

    const result = await detectManagers(tree.root)

    expect(result.managers).toEqual([{ tool, roots: ["apps/a"] }])
  })

  it("reads the object form of package.json#workspaces", async () => {
    await tree.writeJson("package.json", { name: "root", workspaces: { packages: ["apps/*"] } })
    await tree.writePackage("apps/a", { name: "a" })

    expect((await detectManagers(tree.root)).workspaces.map((w) => w.relativeRoot)).toEqual([
      "apps/a",
    ])
  })

  it("takes the most specific lockfile when several are present", async () => {
    await tree.writeJson("package.json", { name: "root", workspaces: ["apps/*"] })
    for (const lockfile of ["pnpm-lock.yaml", "yarn.lock", "bun.lock"]) {
      await tree.writeSource(lockfile, "")
    }

    expect((await detectManagers(tree.root)).managers.map((m) => m.tool)).toEqual(["pnpm"])
  })

  it("resolves nx project.json files into candidates", async () => {
    await tree.writeJson("nx.json", {})
    await tree.writeJson("libs/shared/project.json", {})

    const result = await detectManagers(tree.root)

    expect(result.managers).toEqual([{ tool: "nx", roots: ["libs/shared"] }])
    expect(result.workspaces.map((w) => w.relativeRoot)).toEqual(["libs/shared"])
  })

  it("records turbo as a co-marker without emitting workspaces", async () => {
    await tree.writeJson("turbo.json", {})

    const result = await detectManagers(tree.root)

    expect(result.managers).toEqual([{ tool: "turbo", roots: [] }])
    expect(result.workspaces).toEqual([])
  })

  it("lists candidates by root then tool, and managers by tool", async () => {
    await tree.writePnpmWorkspace("apps/*")
    await tree.writeJson("nx.json", {})
    await tree.writePackage("apps/pricing", { name: "pricing" })
    await tree.writePackage("apps/billing", { name: "billing" })
    await tree.writeJson("apps/billing/project.json", {})
    await tree.writeJson("libs/a/project.json", {})

    const result = await detectManagers(tree.root)

    expect(result.managers.map((m) => m.tool)).toEqual(["nx", "pnpm"])
    expect(result.workspaces.map((w) => `${w.relativeRoot} ${w.managerTool}`)).toEqual([
      "apps/billing nx",
      "apps/billing pnpm",
      "apps/pricing pnpm",
      "libs/a nx",
    ])
  })

  it("lists a directory once per tool when two manifests of that tool declare it", async () => {
    await tree.writePnpmWorkspace("apps/*")
    await tree.writeJson("package.json", { name: "root", workspaces: ["apps/*"] })
    await tree.writeSource("pnpm-lock.yaml", "")
    await tree.writePackage("apps/billing", { name: "billing" })

    const result = await detectManagers(tree.root)

    expect(result.workspaces.map((w) => `${w.relativeRoot} ${w.managerTool}`)).toEqual([
      "apps/billing pnpm",
    ])
  })

  it("refuses a declared package that lies outside the workspace root", async () => {
    await tree.writePackage("outside/pkg", { name: "o" })
    await tree.writePackage("repo/apps/a", { name: "a" })
    await tree.writeSource("repo/pnpm-workspace.yaml", "packages:\n  - apps/*\n  - ../outside/*\n")

    const error = await errorFrom(CoreError, () => detectManagers(join(tree.root, "repo")))

    expect(error.code).toBe("workspace-root-outside")
    expect(error.message).toContain("pnpm workspace root")
    expect(error.value).toContain("..")
  })

  it("spells a workspace root in Unicode NFC, as the paths beside it are spelled", async () => {
    const decomposed = "café".normalize("NFD")
    await tree.writePnpmWorkspace("apps/*")
    await tree.writePackage(`apps/${decomposed}`, { name: "cafe" })

    const result = await detectManagers(tree.root)

    expect(result.workspaces.map((w) => w.relativeRoot)).toEqual([
      `apps/${decomposed.normalize("NFC")}`,
    ])
  })
})
