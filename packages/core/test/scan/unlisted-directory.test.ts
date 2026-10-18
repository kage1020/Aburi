import { join, posix } from "node:path"
import { errorFrom, type ListingFaults } from "@aburi/test-support"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CoreError, detectComponents, detectManagers, discoverFiles } from "../../src"
import { useWorkspaceTree } from "../fixtures/workspace"

const faults = vi.hoisted<ListingFaults>(() => ({ codes: new Map(), refused: new Set() }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const { readdirFailingOn } = await import("@aburi/test-support")
  return { ...actual, readdir: readdirFailingOn(actual, faults) }
})

const tree = useWorkspaceTree("core-unlisted-directory")

afterEach(() => {
  faults.codes.clear()
  faults.refused.clear()
})

function unlistable(directory: string, code = "EACCES"): string {
  const absolute = join(tree.root, directory)
  faults.codes.set(absolute, code)
  return absolute
}

interface Walk {
  /** Put something the walk looks for in `directory`. */
  plant(directory: string): Promise<void>
  run(options: { respectGitignore?: boolean }): Promise<unknown>
}

const discovery: Walk = {
  plant: (directory) => tree.writeSource(`${directory}/b.ts`, "1"),
  run: (options) =>
    discoverFiles({ workspaceRoot: tree.root, languageExtensions: [".ts"], ...options }),
}

describe.each<[string, Walk]>([
  ["discovery", discovery],
  [
    "the language census",
    {
      plant: (directory) => tree.writeLanguageFiles(directory, ".py"),
      run: (options) => detectComponents({ workspaceRoot: tree.root, ...options }),
    },
  ],
  [
    "the nx detector's search for project.json",
    {
      plant: async (directory) => {
        await tree.writeJson("nx.json", {})
        await tree.writeJson(`${directory}/project.json`, { name: "b" })
      },
      run: (options) => detectManagers(tree.root, options),
    },
  ],
  [
    "the resolution of declared package patterns",
    {
      plant: async (directory) => {
        await tree.writePnpmWorkspace(`${posix.dirname(directory)}/*`)
        await tree.writePackage(directory, { name: "b" })
      },
      run: (options) => detectManagers(tree.root, options),
    },
  ],
])("a directory %s cannot list", (_, walk) => {
  it("ends the run, naming the directory and the operating system's error", async () => {
    await walk.plant("src/locked")
    const locked = unlistable("src/locked")

    const error = await errorFrom(CoreError, () => walk.run({}))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: locked })
    expect(error.message).toContain(`"${locked}"`)
    expect(error.message).toContain("EACCES")
  })

  it.each([
    ["itself", "pg/"],
    ["a directory above it", "data/"],
  ])("is passed over when .gitignore excludes %s", async (_excluded, rule) => {
    await walk.plant("data/pg")
    await tree.writeSource(".gitignore", `${rule}\n`)
    const pg = unlistable("data/pg")

    await walk.run({})

    expect(faults.refused).toContain(pg)
  })

  it("ends the run when .gitignore excludes it but is not respected", async () => {
    await walk.plant("data/pg")
    await tree.writeSource(".gitignore", "data/\n")
    const pg = unlistable("data/pg")

    const error = await errorFrom(CoreError, () => walk.run({ respectGitignore: false }))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: pg })
  })
})

describe("a directory a declared pattern reaches outside the workspace", () => {
  it("ends the run when it cannot be listed, whatever a .gitignore out there says", async () => {
    await tree.writeSource("repo/pnpm-workspace.yaml", 'packages:\n  - "../outside/*"\n')
    await tree.writePackage("outside/pkg", { name: "pkg" })
    await tree.writeSource(".gitignore", "outside/\n")
    const pkg = unlistable("outside/pkg")

    const error = await errorFrom(CoreError, () => detectManagers(join(tree.root, "repo")))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: pkg })
  })
})

describe("discovery's walk", () => {
  it.each(["EIO", "EMFILE", "ELOOP"])("ends the run on %s, as on a permission", async (code) => {
    await discovery.plant("src/locked")
    const locked = unlistable("src/locked", code)

    const error = await errorFrom(CoreError, () => discovery.run({}))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: locked })
    expect(error.message).toContain(code)
  })

  it.each([
    "ENOENT",
    "ENOTDIR",
  ])("passes over a directory gone by the time it is listed (%s)", async (code) => {
    await discovery.plant("src")
    await discovery.plant("src/gone")
    const gone = unlistable("src/gone", code)

    const result = await discoverFiles({ workspaceRoot: tree.root, languageExtensions: [".ts"] })

    expect(faults.refused).toContain(gone)
    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts"])
    expect(result.skipped).toEqual([])
  })

  it("names the workspace root when the root itself cannot be listed", async () => {
    await discovery.plant("src")
    faults.codes.set(tree.root, "EACCES")

    const error = await errorFrom(CoreError, () => discovery.run({}))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: tree.root })
  })

  it("never lists a directory the drop globs exclude", async () => {
    await discovery.plant("src")
    for (const directory of ["build", "fixtures", "legacy"]) await discovery.plant(directory)
    const dropped = ["build", "fixtures", "legacy"].map((directory) => unlistable(directory))

    const result = await discoverFiles({
      workspaceRoot: tree.root,
      languageExtensions: [".ts"],
      ignore: ["fixtures/**"],
      langDropPatterns: ["**/legacy/**"],
    })

    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts"])
    for (const directory of dropped) expect(faults.refused).not.toContain(directory)
  })

  it("names the first directory in path order when several cannot be listed", async () => {
    // `src/z` is refused while `src` is walked, before `src/a` has even been listed.
    for (const directory of ["src/a/deep", "src/z"]) await discovery.plant(directory)
    unlistable("src/z")
    const deep = unlistable("src/a/deep")

    const error = await errorFrom(CoreError, () => discovery.run({}))

    expect(error.value).toBe(deep)
  })
})
