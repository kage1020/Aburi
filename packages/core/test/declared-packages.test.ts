import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CoreError, detectComponents, detectManagers } from "../src/index"

/**
 * A `packages:` / `workspaces` entry names a directory that holds a manifest, so each pattern
 * is resolved against the manifest rather than against the directory. The behaviours pinned
 * here are pnpm's own, measured with `pnpm ls -r` on the same trees these fixtures build.
 */

let tmp = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "aburi-core-declared-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writePackage(relativeDir: string, name: string): Promise<void> {
  const dir = join(tmp, relativeDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }), "utf8")
}

async function writePnpmManifest(...patterns: string[]): Promise<void> {
  const lines = patterns.map((pattern) => `  - ${JSON.stringify(pattern)}`).join("\n")
  await writeFile(join(tmp, "pnpm-workspace.yaml"), `packages:\n${lines}\n`, "utf8")
}

async function pnpmRoots(): Promise<string[]> {
  const { workspaces } = await detectManagers(tmp)
  return workspaces
    .filter((candidate) => candidate.managerTool === "pnpm")
    .map((candidate) => candidate.relativeRoot)
    .sort()
}

/**
 * Directories that are not packages, spread across the depths a directory walk would reach.
 * Every assertion below is really the same one — none of these may become a candidate.
 */
async function writeNonPackageDirectories(): Promise<void> {
  await mkdir(join(tmp, "src"), { recursive: true })
  await mkdir(join(tmp, "a", "b", "c", "d"), { recursive: true })
}

describe("a declared package is the directory that holds the manifest", () => {
  it("resolves '.' to the workspace root, not to every directory under it", async () => {
    await writePackage(".", "root-pkg")
    await writePackage("packages/app", "app")
    await writeNonPackageDirectories()
    await writePnpmManifest(".", "packages/*")

    expect(await pnpmRoots()).toEqual([".", "packages/app"])
  })

  it("reads a trailing slash as the same root", async () => {
    await writePackage(".", "root-pkg")
    await writeNonPackageDirectories()
    await writePnpmManifest("./")

    expect(await pnpmRoots()).toEqual(["."])
  })

  it("declares nothing for '.' when the root holds no manifest", async () => {
    await writePackage("packages/app", "app")
    await writeNonPackageDirectories()
    await writePnpmManifest(".")

    expect(await pnpmRoots()).toEqual([])
  })

  it("resolves a literal path to that directory alone, not to its subtree", async () => {
    await writePackage("tools/build", "build")
    await writePackage("tools/build/nested", "nested")
    await writePnpmManifest("tools/build")

    expect(await pnpmRoots()).toEqual(["tools/build"])
  })

  it("passes over a matched directory that holds no manifest", async () => {
    await writePackage("packages/app", "app")
    await mkdir(join(tmp, "packages", "dist"), { recursive: true })
    await writePnpmManifest("packages/*")

    expect(await pnpmRoots()).toEqual(["packages/app"])
  })

  it("honours a negated pattern", async () => {
    await writePackage("packages/app", "app")
    await writePackage("packages/skipme", "skipme")
    await writePnpmManifest("packages/*", "!packages/skipme")

    expect(await pnpmRoots()).toEqual(["packages/app"])
  })

  it("passes over a directory that is itself named package.json", async () => {
    await writePackage("packages/app", "app")
    await mkdir(join(tmp, "packages", "weird", "package.json"), { recursive: true })
    await writeFile(join(tmp, "packages", "weird", "package.json", "inner.txt"), "x", "utf8")
    await writePnpmManifest("packages/*")

    expect(await pnpmRoots()).toEqual(["packages/app"])
  })

  it("passes over a dependency's own manifest", async () => {
    // `**` is the one pattern that reaches into `node_modules`, and a workspace that declares
    // it would otherwise take every installed dependency for one of its own packages.
    await writePackage("packages/app", "app")
    await writePackage("node_modules/left-pad", "left-pad")
    await writePnpmManifest("**")

    expect(await pnpmRoots()).toEqual(["packages/app"])
  })

  it("reaches ten directory levels down and stops there", async () => {
    // The documented ceiling for `**` (component-detect.md §3.1.1), pinned from both sides: a
    // workspace that nests its packages under a few grouping directories is ordinary, and one
    // package at the ceiling with another just past it is what says where the ceiling is.
    const deep = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("/")
    await writePackage(deep, "deep")
    await writePackage(`${deep}/l11`, "past-the-ceiling")
    await writePnpmManifest("**")

    expect(await pnpmRoots()).toEqual([deep])
  })

  it("falls back to the whole repository when no matched directory holds a manifest", async () => {
    // `detectComponents` reads "no candidate" as "no detector hit", so patterns that matched
    // nothing land on the single-project fallback rather than on nothing at all. Whether that
    // is the right answer depends on why they matched nothing, and detection has no channel
    // to say which — component-detect.md §5 carries the two cases.
    await mkdir(join(tmp, "packages", "one"), { recursive: true })
    await mkdir(join(tmp, "packages", "two"), { recursive: true })
    await writePnpmManifest("packages/*")

    const { managers } = await detectManagers(tmp)
    expect(managers).toEqual([{ tool: "pnpm", roots: [] }])

    const components = await detectComponents({ workspaceRoot: tmp })
    expect(components).toHaveLength(1)
    expect(components[0]?.roots).toEqual(["."])
  })

  it("declares nothing for an empty pattern", async () => {
    // The transform would otherwise turn it into "/package.json", which names the filesystem
    // root rather than anything inside the workspace.
    await writePackage("packages/app", "app")
    await writePnpmManifest("")

    expect(await pnpmRoots()).toEqual([])
  })

  it("still refuses a pattern that ascends out of the workspace", async () => {
    await writePackage("outside/pkg", "outside")
    await mkdir(join(tmp, "repo"), { recursive: true })
    await writeFile(join(tmp, "repo", "package.json"), JSON.stringify({ name: "root" }), "utf8")
    await mkdir(join(tmp, "repo", "apps", "a"), { recursive: true })
    await writeFile(
      join(tmp, "repo", "apps", "a", "package.json"),
      JSON.stringify({ name: "a" }),
      "utf8",
    )
    await writeFile(
      join(tmp, "repo", "pnpm-workspace.yaml"),
      'packages:\n  - "apps/*"\n  - "../outside/*"\n',
      "utf8",
    )

    const thrown = await detectManagers(join(tmp, "repo")).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CoreError)
    expect((thrown as CoreError).code).toBe("workspace-root-outside")
  })

  it("carries the matched manifest on every candidate", async () => {
    await writePackage(".", "root-pkg")
    await writePackage("packages/app", "app")
    await writePnpmManifest(".", "packages/*")

    const { workspaces } = await detectManagers(tmp)
    expect(workspaces.length).toBeGreaterThan(0)
    for (const candidate of workspaces) {
      expect(basename(candidate.manifestPath)).toBe("package.json")
    }
  })

  it("applies the same rule to npm workspaces", async () => {
    await writeNonPackageDirectories()
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root-pkg", workspaces: [".", "apps/*"] }),
      "utf8",
    )
    await writePackage("apps/a", "a")

    const { workspaces } = await detectManagers(tmp)
    expect(workspaces.map((candidate) => candidate.relativeRoot).sort()).toEqual([".", "apps/a"])
  })
})

describe("the workspace root as a declared component", () => {
  /** Enough files to clear the language census thresholds (≥10 files and ≥5% share). */
  async function seedFiles(relativeDir: string, extension: string, count: number): Promise<void> {
    const dir = join(tmp, relativeDir)
    await mkdir(dir, { recursive: true })
    for (let i = 0; i < count; i++) {
      await writeFile(join(dir, `f${i}.${extension}`), `x${i} = ${i}\n`, "utf8")
    }
  }

  async function seedTypescript(relativeDir: string, count: number): Promise<void> {
    await seedFiles(relativeDir, "ts", count)
  }

  it("becomes one component beside the packages, not one per directory", async () => {
    await writePackage(".", "root-pkg")
    await writePackage("packages/app", "app")
    await writeNonPackageDirectories()
    await seedTypescript("src", 12)
    await seedTypescript("packages/app/src", 12)
    await writePnpmManifest(".", "packages/*")

    const components = await detectComponents({ workspaceRoot: tmp })

    expect(components.map((c) => c.id)).toEqual(["app", "root-pkg"])
    expect(components.find((c) => c.id === "root-pkg")?.roots).toEqual(["."])
  })

  it("censuses the root's own files", async () => {
    await writePackage(".", "root-pkg")
    await seedTypescript("src", 12)
    await writePnpmManifest(".")

    const components = await detectComponents({ workspaceRoot: tmp })

    expect(components).toHaveLength(1)
    expect(components[0]?.languages).toEqual(["ts"])
  })

  it("censuses the packages nested under it as its own subtree", async () => {
    // §4.4 counts each component's subtree, and the root's subtree holds the other packages.
    // A root declared beside them is the shape this rule makes ordinary, so what its
    // `languages` then contains is worth saying out loud rather than leaving to be found.
    await writePackage(".", "root-pkg")
    await writePackage("packages/app", "app")
    await seedFiles("services", "py", 12)
    await seedTypescript("packages/app/src", 12)
    await writePnpmManifest(".", "packages/*")

    const components = await detectComponents({ workspaceRoot: tmp })

    expect(components.find((c) => c.id === "app")?.languages).toEqual(["ts"])
    expect(components.find((c) => c.id === "root-pkg")?.languages).toEqual(["py", "ts"])
  })

  it("names the root after its directory when the root manifest carries no name", async () => {
    // `relativeRoot` is "." here, so the id cannot come from the path's trailing segment the
    // way every other component's does — the root's own directory name is what is left.
    const root = join(tmp, "storefront")
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }), "utf8")
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "."\n', "utf8")

    const components = await detectComponents({ workspaceRoot: root })

    expect(components).toHaveLength(1)
    expect(components[0]?.id).toBe("storefront")
    expect(components[0]?.roots).toEqual(["."])
  })
})
