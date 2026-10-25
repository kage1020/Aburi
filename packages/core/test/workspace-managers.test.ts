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

  it("finds an nx project.json in a dot directory, and none under .git or in a nested checkout", async () => {
    await tree.writeJson("nx.json", {})
    await tree.writeJson("libs/shared/project.json", {})
    await tree.writeJson(".github/actions/deploy/project.json", {})
    await tree.writeJson(".git/modules/vendored/project.json", {})
    await tree.writeJson(".worktrees/feat/libs/shared/project.json", {})
    await tree.writeSource(".worktrees/feat/.git", "gitdir: /r/.git/worktrees/feat\n")

    const result = await detectManagers(tree.root)

    expect(result.workspaces.map((w) => w.relativeRoot)).toEqual([
      ".github/actions/deploy",
      "libs/shared",
    ])
  })

  it.each([
    ["leaves out a project.json .gitignore excludes, as nx does", {}, ["libs/shared"]],
    [
      "keeps a git-ignored project.json when .gitignore is not respected",
      { respectGitignore: false },
      ["build", "libs/shared"],
    ],
  ])("%s", async (_, options, roots) => {
    await tree.writeJson("nx.json", {})
    await tree.writeJson("libs/shared/project.json", {})
    await tree.writeJson("build/project.json", {})
    await tree.writeSource(".gitignore", "build/\n")

    const result = await detectManagers(tree.root, options)

    expect(result.managers).toEqual([{ tool: "nx", roots }])
  })

  it("passes over the caches nx's own walk skips, whatever .gitignore says", async () => {
    await tree.writeJson("nx.json", {})
    await tree.writeJson("libs/shared/project.json", {})
    for (const cache of [".nx/cache/a", ".nx/workspace-data/b", ".yarn/cache/c"]) {
      await tree.writeJson(`${cache}/project.json`, {})
    }

    const result = await detectManagers(tree.root, { respectGitignore: false })

    expect(result.managers).toEqual([{ tool: "nx", roots: ["libs/shared"] }])
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

  it.each([
    ["pkg"],
    ...(process.platform === "win32" ? [] : [["x\\pkg"]]),
  ])("refuses a declared package that lies outside the workspace root, at ../outside/%s", async (name) => {
    await tree.writePackage(`outside/${name}`, { name: "o" })
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

const onPosix = it.skipIf(process.platform === "win32")

describe("detectManagers — a package whose directory no Document path can spell", () => {
  onPosix.each([
    ["a top-level name that reads as a drive", "a:pkg", "drive-shaped-name"],
    ["a backslash", "x\\pkg", "unspellable-name"],
  ])("leaves out and reports a package through %s, and keeps the rest", async (_, odd, reason) => {
    await tree.writePnpmWorkspace("*")
    await tree.writeJson("nx.json", {})
    for (const directory of [odd, "ok"]) {
      await tree.writePackage(directory, { name: directory === "ok" ? "ok" : "odd" })
      await tree.writeJson(`${directory}/project.json`, {})
    }

    const result = await detectManagers(tree.root)

    expect(result.managers).toEqual([
      { tool: "nx", roots: ["ok"] },
      { tool: "pnpm", roots: ["ok"] },
    ])
    expect(result.workspaces.map((w) => `${w.relativeRoot} ${w.managerTool}`)).toEqual([
      "ok nx",
      "ok pnpm",
    ])
    expect(result.unnameableRoots).toEqual([
      { tool: "nx", manifestPath: "nx.json", relativeRoot: odd, reason, unnameablePrefix: odd },
      {
        tool: "pnpm",
        manifestPath: "pnpm-workspace.yaml",
        relativeRoot: odd,
        reason,
        unnameablePrefix: odd,
      },
    ])
  })

  onPosix.each<[string, string, readonly string[], readonly string[]]>([
    ["a:pkg", "is left out without the pattern counting as unresolved", [], ["a:pkg"]],
    ["ab:pkg", "is a root, since its colon is not a drive's", ["ab:pkg"], []],
  ])("the only package, at %s, %s", async (directory, _, roots, unnameable) => {
    await tree.writePnpmWorkspace("*")
    await tree.writePackage(directory, { name: "only" })

    const result = await detectManagers(tree.root)

    expect(result.managers).toEqual([{ tool: "pnpm", roots }])
    expect(result.unnameableRoots.map((root) => root.relativeRoot)).toEqual(unnameable)
    expect(result.unresolved).toEqual([])
  })

  onPosix.each([
    ["names the directory to rename when the package sits below it", "*/*", "d:data/pkg", "d:data"],
    ["spells the root as it is on disk, not as NFC", "*", "\u212A:pkg", "\u212A:pkg"],
  ])("%s", async (_, pattern, directory, prefix) => {
    await tree.writePnpmWorkspace(pattern)
    await tree.writePackage(directory, { name: "odd" })

    expect((await detectManagers(tree.root)).unnameableRoots).toEqual([
      {
        tool: "pnpm",
        manifestPath: "pnpm-workspace.yaml",
        relativeRoot: directory,
        reason: "drive-shaped-name",
        unnameablePrefix: prefix,
      },
    ])
  })
})
