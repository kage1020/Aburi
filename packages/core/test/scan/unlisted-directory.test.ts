import { join, posix } from "node:path"
import { clearListingFaults, errorFrom, linkDirectory } from "@aburi/test-support"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CoreError, detectComponents, detectManagers, discoverFiles } from "../../src"
import { useWorkspaceTree } from "../fixtures/workspace"

const faults = await vi.hoisted(async () =>
  (await import("@aburi/test-support")).emptyListingFaults(),
)

vi.mock("node:fs", async (importOriginal) => {
  const { fsFailingOn } = await import("@aburi/test-support")
  return fsFailingOn(await importOriginal<typeof import("node:fs")>(), faults)
})

const tree = useWorkspaceTree("core-unlisted-directory")

afterEach(() => clearListingFaults(faults))

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

const census: Walk = {
  plant: (directory) => tree.writeLanguageFiles(directory, ".py"),
  run: (options) => detectComponents({ workspaceRoot: tree.root, ...options }),
}

const nxSearch: Walk = {
  plant: async (directory) => {
    await tree.writeJson("nx.json", {})
    await tree.writeJson(`${directory}/project.json`, { name: "b" })
  },
  run: (options) => detectManagers(tree.root, options),
}

const declaredPatterns: Walk = {
  plant: async (directory) => {
    await tree.writePnpmWorkspace(`${posix.dirname(directory)}/*`)
    await tree.writePackage(directory, { name: "b" })
  },
  run: (options) => detectManagers(tree.root, options),
}

const WALKS: [string, Walk][] = [
  ["discovery", discovery],
  ["the language census", census],
  ["the nx detector's search for project.json", nxSearch],
  ["the resolution of declared package patterns", declaredPatterns],
]

describe.each(WALKS)("a directory %s cannot list", (_, walk) => {
  it.each([
    "src/locked",
    ".config/locked",
  ])("ends the run at %s, naming the directory and the operating system's error", async (directory) => {
    await walk.plant(directory)
    const locked = unlistable(directory)

    const error = await errorFrom(CoreError, () => walk.run({}))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: locked })
    expect(error.message).toContain(`"${locked}"`)
    expect(error.message).toContain("EACCES")
  })
})

// Declared patterns never read .gitignore, as pnpm and npm do not.
const GITIGNORE_WALKS = WALKS.filter(([, walk]) => walk !== declaredPatterns)

describe.each(GITIGNORE_WALKS)("a directory %s cannot list but .gitignore excludes", (_, walk) => {
  it("is passed over", async () => {
    await walk.plant("data/pg")
    await tree.writeSource(".gitignore", "pg/\n")
    const pg = unlistable("data/pg")

    await walk.run({})

    expect(faults.refused).toContain(pg)
  })

  it("ends the run when .gitignore is not respected", async () => {
    await walk.plant("data/pg")
    await tree.writeSource(".gitignore", "pg/\n")
    const pg = unlistable("data/pg")

    const error = await errorFrom(CoreError, () => walk.run({ respectGitignore: false }))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: pg })
  })
})

describe.each(WALKS)("%s", (_, walk) => {
  it("never lists a .git directory, at the root or in a nested repository", async () => {
    await walk.plant("src")
    const stores = [".git", "libs/vendored/.git"]
    for (const store of stores) await tree.mkdir(store)
    const refusable = stores.map((store) => unlistable(store))

    await walk.run({})

    for (const store of refusable) expect(faults.refused).not.toContain(store)
  })
})

describe("which directories .gitignore excuses", () => {
  it.each([
    ["one under a directory it excludes", { ".gitignore": "data/\n" }],
    ["one a deeper rule file excludes", { "data/.gitignore": "pg/\n" }],
  ])("passes over %s", async (_, rules) => {
    await discovery.plant("data/pg")
    for (const [path, text] of Object.entries(rules)) await tree.writeSource(path, text)
    const pg = unlistable("data/pg")

    await discovery.run({})

    expect(faults.refused).toContain(pg)
  })

  it.each([
    ["excludes only what is in it", { ".gitignore": "data/pg/*\n" }],
    ["is re-included by a deeper rule", { ".gitignore": "data/*\n", "data/.gitignore": "!pg/\n" }],
  ])("ends the run for one that %s", async (_, rules) => {
    await discovery.plant("data/pg")
    for (const [path, text] of Object.entries(rules)) await tree.writeSource(path, text)
    const pg = unlistable("data/pg")

    const error = await errorFrom(CoreError, () => discovery.run({}))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: pg })
    expect(error.message).toContain("Exclude it in .gitignore, or let this process read it")
  })

  it("still names a directory it cannot list when an excused one sorts before it", async () => {
    await discovery.plant("data/pg")
    await discovery.plant("src/locked")
    await tree.writeSource(".gitignore", "data/\n")
    const pg = unlistable("data/pg")
    const locked = unlistable("src/locked")

    const error = await errorFrom(CoreError, () => discovery.run({}))

    expect(error.value).toBe(locked)
    expect(faults.refused).toContain(pg)
  })

  it("never excuses the workspace root, whatever .gitignore says", async () => {
    await discovery.plant("src")
    await tree.writeSource(".gitignore", "*\n!*.ts\n")
    faults.codes.set(tree.root, "EACCES")

    const error = await errorFrom(CoreError, () => discovery.run({}))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: tree.root })
  })
})

describe("a directory a declared pattern reaches", () => {
  it("ends the run when it cannot be listed, though .gitignore excludes it", async () => {
    await declaredPatterns.plant("data/pg")
    await tree.writeSource(".gitignore", "data/\n")
    const pg = unlistable("data/pg")

    const error = await errorFrom(CoreError, () => detectManagers(tree.root))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: pg })
    expect(error.message).not.toContain(".gitignore")
  })

  it("ends the run outside the workspace too", async () => {
    await tree.writeSource("repo/pnpm-workspace.yaml", 'packages:\n  - "../outside/*"\n')
    await tree.writePackage("outside/pkg", { name: "pkg" })
    const pkg = unlistable("outside/pkg")

    const error = await errorFrom(CoreError, () => detectManagers(join(tree.root, "repo")))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: pkg })
  })

  async function linkedPackage(): Promise<string> {
    await tree.writePnpmWorkspace("packages/*")
    await tree.writePackage("packages/bar", { name: "bar" })
    await tree.writePackage("vendor/foo", { name: "foo" })
    const link = join(tree.root, "packages", "foo")
    await linkDirectory(join(tree.root, "vendor", "foo"), link)
    return link
  }

  it.each([
    "EACCES",
    "EIO",
    "EPERM",
  ])("ends the run when a link to it cannot be resolved (%s), naming the link", async (code) => {
    const link = await linkedPackage()
    faults.links.set(link, code)

    const error = await errorFrom(CoreError, () => detectManagers(tree.root))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: link })
    expect(error.message).toContain(`Link "${link}" could not be followed: ${code}`)
  })

  it("names the link when what it resolves to cannot be looked up", async () => {
    const link = await linkedPackage()
    faults.targets.set(join(tree.root, "vendor", "foo"), "EIO")

    const error = await errorFrom(CoreError, () => detectManagers(tree.root))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: link })
  })

  it.each([
    "ENOENT",
    "ELOOP",
  ])("passes over a link that dangles or loops (%s), as every checkout does", async (code) => {
    const link = await linkedPackage()
    faults.links.set(link, code)

    const result = await detectManagers(tree.root)

    expect(faults.refused).toContain(link)
    expect(result.workspaces.map((candidate) => candidate.relativeRoot)).toEqual(["packages/bar"])
  })
})

describe("detectComponents", () => {
  it("hands respectGitignore on to the manifest searches", async () => {
    await nxSearch.plant("build")
    await tree.writeSource(".gitignore", "build/\n")
    const build = unlistable("build")

    const error = await errorFrom(CoreError, () =>
      detectComponents({ workspaceRoot: tree.root, respectGitignore: false }),
    )

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: build })
  })
})

describe("detectManagers", () => {
  it("names the first directory in path order whichever search fails first", async () => {
    await nxSearch.plant("a/locked")
    await declaredPatterns.plant("apps/locked")
    const first = unlistable("a/locked")
    unlistable("apps/locked")

    const error = await errorFrom(CoreError, () => detectManagers(tree.root))

    expect(error.value).toBe(first)
  })
})

describe("discovery's walk", () => {
  it.each([
    "EIO",
    "EMFILE",
    "ELOOP",
    "EPERM",
  ])("ends the run on %s, as on a permission", async (code) => {
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

  it("ends the run when an entry, not its directory, vanishes mid-listing", async () => {
    await discovery.plant("src/gen")
    const gen = join(tree.root, "src", "gen")
    faults.vanishedEntries.set(gen, "x.ts")

    const error = await errorFrom(CoreError, () => discovery.run({}))

    expect(error).toMatchObject({ code: "scan-directory-unreadable", value: gen })
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

  it("orders the paths it compares by code unit, as git does", async () => {
    for (const directory of ["src/B", "src/a"]) await discovery.plant(directory)
    unlistable("src/a")
    const upper = unlistable("src/B")

    const error = await errorFrom(CoreError, () => discovery.run({}))

    expect(error.value).toBe(upper)
  })
})
