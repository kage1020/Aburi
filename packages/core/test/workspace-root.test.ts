import { chmod } from "node:fs/promises"
import { join, relative } from "node:path"
import { errorFrom, linkDirectory } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CoreError, type DetectWorkspaceRootOptions, detectWorkspaceRoot } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-workspace-root")

async function rootFrom(...segments: string[]): Promise<string> {
  return detectWorkspaceRoot({ cwd: join(tree.root, ...segments) })
}

async function codeFrom(...segments: string[]): Promise<string> {
  return (await errorFrom(CoreError, () => rootFrom(...segments))).code
}

describe("a directory is a workspace root when it holds a marker", () => {
  it.each([
    ["pnpm-workspace.yaml", "packages: ['apps/*']"],
    ["turbo.json", "{}"],
    ["nx.json", "{}"],
    ["lerna.json", "{}"],
    ["go.work", "go 1.22\n"],
    [".aburi-workspace", ""],
    ["package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] })],
    ["Cargo.toml", '[workspace]\nmembers = ["crate-a"]\n'],
    ["Cargo.toml", '[workspace.members]\ncrate-a = "crate-a"\n'],
    ["pyproject.toml", '[tool.uv.workspace]\nmembers = ["pkg-a"]\n'],
    ["pyproject.toml", '[tool.hatch.workspaces]\nmembers = ["pkg-a"]\n'],
    ["pyproject.toml", '[tool.poetry]\nname = "root"\n'],
  ])("%s holding %j, with or without a byte order mark opening it", async (file, content) => {
    await tree.writeSource(file, content)
    expect(await rootFrom()).toBe(tree.root)

    await tree.writeSource(file, `\uFEFF${content}`)
    expect(await rootFrom()).toBe(tree.root)
  })

  it.each([
    ["package.json", JSON.stringify({ name: "plain-pkg" })],
    ["Cargo.toml", '[package]\nname = "crate-a"\n'],
    ["pyproject.toml", '[project]\nname = "pkg-a"\n'],
  ])("but not %s holding %j", async (file, content) => {
    await tree.writeSource(file, content)

    expect(await codeFrom()).toBe("workspace-root-not-found")
  })

  it("resolves a relative cwd against the process's working directory", async () => {
    await tree.writeSource("turbo.json", "{}")
    await tree.mkdir("src")

    const cwd = relative(process.cwd(), join(tree.root, "src"))

    expect(await detectWorkspaceRoot({ cwd })).toBe(tree.root)
  })
})

describe("the walk upward", () => {
  it("roots at an outer package.json#workspaces that opens with a byte order mark", async () => {
    await tree.writeSource("package.json", '\uFEFF{ "workspaces": ["apps/*"] }')
    await tree.writeSource("apps/billing/turbo.json", "{}")

    expect(await rootFrom("apps", "billing")).toBe(tree.root)
  })

  it("prefers the outermost marker over an inner package.json#workspaces", async () => {
    await tree.mkdir(".git")
    await tree.writePackage("apps/billing", { name: "billing", workspaces: ["lib/*"] })

    expect(await rootFrom("apps", "billing")).toBe(tree.root)
  })

  it("stops at a repository nested under another marker", async () => {
    await tree.mkdir(".git")
    await tree.mkdir("vendor/lib/.git")
    await tree.mkdir("vendor/lib/src")

    expect(await rootFrom("vendor", "lib", "src")).toBe(join(tree.root, "vendor", "lib"))
  })

  it("stops at the `.git` file a linked worktree or a submodule has", async () => {
    await tree.writeSource("pnpm-workspace.yaml", "packages: ['apps/*']")
    await tree.mkdir(".git")
    await tree.mkdir(".worktrees/feat/src")
    await tree.writeSource(".worktrees/feat/.git", "gitdir: ../../.git/worktrees/feat\n")

    expect(await rootFrom(".worktrees", "feat", "src")).toBe(join(tree.root, ".worktrees", "feat"))
  })

  it("stops at a `.git` beside another marker, in any probing order", async () => {
    await tree.writeSource("turbo.json", "{}")
    await tree.mkdir("repo/.git")
    await tree.mkdir("repo/src")
    await tree.writeSource("repo/turbo.json", "{}")

    expect(await rootFrom("repo", "src")).toBe(join(tree.root, "repo"))
  })

  it("passes a `.git` file that is not a `gitdir:` pointer", async () => {
    await tree.mkdir(".git")
    await tree.mkdir("vendor/lib/src")
    await tree.writeSource("vendor/lib/.git", "")

    expect(await rootFrom("vendor", "lib", "src")).toBe(tree.root)
  })
})

describe("a working tree git finds through the environment", () => {
  const rootUnder = (env: NonNullable<DetectWorkspaceRootOptions["env"]>, ...segments: string[]) =>
    detectWorkspaceRoot({ cwd: join(tree.root, ...segments), env })

  async function workTreeBelowMarker(): Promise<string> {
    await tree.writeSource("pnpm-workspace.yaml", "packages: []")
    await tree.writeSource(
      "outer/wt/package.json",
      JSON.stringify({ name: "demo", workspaces: [] }),
    )
    await tree.mkdir("outer/wt/src")
    return join(tree.root, "outer", "wt")
  }

  it.each<[string, (workTree: string) => string, string[]]>([
    ["from the work tree", (workTree) => workTree, ["outer", "wt"]],
    ["from below it", (workTree) => workTree, ["outer", "wt", "src"]],
    ["named relative to the start, as git resolves it", () => "..", ["outer", "wt", "src"]],
  ])("roots at GIT_WORK_TREE, though a marker sits above it, %s", async (_, name, start) => {
    const workTree = await workTreeBelowMarker()

    expect(await rootUnder({ GIT_WORK_TREE: name(workTree) }, ...start)).toBe(workTree)
  })

  it("roots at GIT_WORK_TREE spelled through a link, under the name the walk meets it by", async () => {
    const workTree = await workTreeBelowMarker()
    await linkDirectory(workTree, join(tree.root, "alias"))

    const env = { GIT_WORK_TREE: join(tree.root, "alias") }
    expect(await rootUnder(env, "outer", "wt", "src")).toBe(workTree)
  })

  it("still stops at a repository nested inside GIT_WORK_TREE", async () => {
    const workTree = await workTreeBelowMarker()
    await tree.mkdir("outer/wt/vendor/lib/.git")

    const env = { GIT_WORK_TREE: workTree }
    expect(await rootUnder(env, "outer", "wt", "vendor", "lib")).toBe(
      join(workTree, "vendor", "lib"),
    )
  })

  it.each<[string, NonNullable<DetectWorkspaceRootOptions["env"]>]>([
    ["a GIT_WORK_TREE the start is not inside", { GIT_WORK_TREE: "/nowhere/else" }],
    ["an empty GIT_WORK_TREE and GIT_DIR", { GIT_WORK_TREE: "", GIT_DIR: "" }],
  ])("climbs past the work tree for %s", async (_, env) => {
    await workTreeBelowMarker()

    expect(await rootUnder(env, "outer", "wt", "src")).toBe(tree.root)
  })

  it("roots at the start under GIT_DIR alone, which git takes as the top of its work tree", async () => {
    await workTreeBelowMarker()

    const env = { GIT_DIR: join(tree.root, "repo.git") }
    expect(await rootUnder(env, "outer", "wt", "src")).toBe(join(tree.root, "outer", "wt", "src"))
  })

  it("stops at a `.git` above the start under GIT_DIR alone, as a hook run from a package does", async () => {
    await tree.mkdir(".git")
    await tree.mkdir("packages/app")

    expect(await rootUnder({ GIT_DIR: ".git" }, "packages", "app")).toBe(tree.root)
  })
})

describe("a manifest that cannot be read", () => {
  it("is raised below the workspace root", async () => {
    await tree.mkdir(".git")
    await tree.writeSource("apps/billing/package.json", "{ not json")

    expect(await codeFrom("apps", "billing")).toBe("workspace-manifest-malformed")
  })

  it.each([
    ["that is not JSON", "{ not json"],
    ["with a byte order mark after its first character", '{\uFEFF "workspaces": [] }'],
  ])("is raised at the workspace root itself, for a manifest %s", async (_case, content) => {
    await tree.writeSource("package.json", content)
    await tree.writeSource("Cargo.toml", '[workspace]\nmembers = ["crate-a"]\n')

    expect(await codeFrom()).toBe("workspace-manifest-malformed")
  })

  it("is never opened in a directory a `.git` already makes the root", async () => {
    await tree.mkdir(".git")
    await tree.writeSource("package.json", "{ not json")

    expect(await rootFrom()).toBe(tree.root)
  })

  it("is ignored above the workspace root", async () => {
    await tree.writeSource("home/repo/pnpm-workspace.yaml", "packages: ['apps/*']")
    await tree.writeSource("home/package.json", "{ not json")

    expect(await rootFrom("home", "repo")).toBe(join(tree.root, "home", "repo"))
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "is ignored above the workspace root when the filesystem refuses it",
    async () => {
      await tree.writeSource("home/repo/pnpm-workspace.yaml", "packages: ['apps/*']")
      const denied = join(tree.root, "home", "package.json")
      await tree.writeSource("home/package.json", JSON.stringify({ name: "someone-else" }))
      await chmod(denied, 0o000)
      try {
        expect(await rootFrom("home", "repo")).toBe(join(tree.root, "home", "repo"))
      } finally {
        await chmod(denied, 0o600)
      }
    },
  )

  it("leaves an absent root reported as workspace-root-not-found", async () => {
    await tree.mkdir("home/plain")
    await tree.writeSource("home/package.json", "{ not json")

    expect(await codeFrom("home", "plain")).toBe("workspace-root-not-found")
  })
})
