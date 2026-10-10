import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { detectComponents } from "../src/index"

let workRoot: string

/** Ten files of `extension` under `directory`, which is what the frequency filter needs. */
async function writeLanguage(directory: string, extension: string, count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await writeFileAt(join(directory, `f${index}${extension}`))
  }
}

async function writeFileAt(rel: string, content = "x"): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

/** The pnpm marker, whose `packages` list is what decides the component roots. */
async function writeWorkspaceManifest(patterns: readonly string[]): Promise<void> {
  const lines = ["packages:", ...patterns.map((pattern) => `  - '${pattern}'`), ""]
  await writeFileAt("pnpm-workspace.yaml", lines.join("\n"))
}

/** A single-project workspace: no manager markers, so the root itself is the one component. */
async function languagesOfRoot(
  options: { ignore?: readonly string[]; respectGitignore?: boolean } = {},
): Promise<readonly string[]> {
  const components = await detectComponents({ workspaceRoot: workRoot, ...options })
  expect(components).toHaveLength(1)
  return components[0]?.languages ?? []
}

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-component-drops-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

describe("detection drops what discovery drops", () => {
  it("does not count a directory only the shared core list names", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("out", ".py")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })

  it("does not count a tree the workspace git-ignores", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("generated", ".py")
    await writeFileAt(".gitignore", "generated/\n")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })

  it("honours a nested .gitignore, as discovery does", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("src/vendored", ".py")
    await writeFileAt(join("src", ".gitignore"), "vendored/\n")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })

  it("counts the git-ignored files again when respectGitignore is off", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("generated", ".py")
    await writeFileAt(".gitignore", "generated/\n")

    expect(await languagesOfRoot({ respectGitignore: false })).toEqual(["py", "ts"])
  })

  it("takes the caller's ignore globs", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("fixtures", ".py")

    expect(await languagesOfRoot({ ignore: ["fixtures/**"] })).toEqual(["ts"])
  })

  it("leaves the ts fallback when everything a component holds was excluded", async () => {
    // `Component.languages` is `minItems: 1` on the wire, so detection cannot hand back none.
    await writeLanguage("generated", ".py")
    await writeFileAt(".gitignore", "generated/\n")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })
})

describe("what the drop decision is relative to", () => {
  /** A pnpm workspace with two packages, so component roots and the workspace root differ. */
  async function makeMonorepo(): Promise<void> {
    await writeFileAt("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n")
    await writeFileAt("package.json", JSON.stringify({ name: "root", private: true }))
    for (const name of ["app", "other"]) {
      await writeFileAt(join("packages", name, "package.json"), JSON.stringify({ name }))
      await writeLanguage(join("packages", name, "src"), ".ts")
      await writeLanguage(join("packages", name, "fixtures"), ".py")
    }
  }

  it("reads an ignore glob against the workspace root, not each component root", async () => {
    await makeMonorepo()

    const components = await detectComponents({
      workspaceRoot: workRoot,
      ignore: ["packages/app/fixtures/**"],
    })

    const byId = new Map(components.map((c) => [c.id as string, c.languages as readonly string[]]))
    expect(byId.get("app")).toEqual(["ts"])
    expect(byId.get("other")).toEqual(["py", "ts"])
  })

  it("counts three levels below each root, whichever root, with roots at different depths", async () => {
    await writeWorkspaceManifest(["packages/*", "packages/app/inner/*"])
    await writeFileAt("package.json", JSON.stringify({ name: "root", private: true }))
    await writeFileAt(join("packages", "app", "package.json"), JSON.stringify({ name: "app" }))
    await writeLanguage(join("packages", "app", "src"), ".ts")
    // Exactly three directories below `packages/app` — the last depth that counts.
    await writeLanguage(join("packages", "app", "a", "b", "c"), ".go")
    // Four below it: the first that does not.
    await writeLanguage(join("packages", "app", "x", "y", "z", "w"), ".rb")
    await writeFileAt(
      join("packages", "app", "inner", "deep", "package.json"),
      JSON.stringify({ name: "deep" }),
    )
    await writeLanguage(join("packages", "app", "inner", "deep", "p", "q", "r"), ".rs")

    const components = await detectComponents({ workspaceRoot: workRoot })

    const byId = new Map(components.map((c) => [c.id as string, c.languages as readonly string[]]))
    expect(byId.get("app")).toEqual(["go", "ts"])
    expect(byId.get("deep")).toEqual(["rs"])
  })

  it("holds the depth limit for the workspace root when it is one root among several", async () => {
    await writeFileAt("nx.json", JSON.stringify({ version: 2 }))
    await writeFileAt("project.json", JSON.stringify({ name: "root" }))
    await writeFileAt("package.json", JSON.stringify({ name: "root", private: true }))
    await writeLanguage("src", ".ts")
    await writeFileAt(join("packages", "app", "project.json"), JSON.stringify({ name: "app" }))
    await writeFileAt(join("packages", "app", "package.json"), JSON.stringify({ name: "app" }))
    await writeLanguage(join("packages", "app", "src"), ".ts")
    await writeLanguage(join("a", "b", "c"), ".go")
    await writeLanguage(join("x", "y", "z", "w"), ".rb")

    const components = await detectComponents({ workspaceRoot: workRoot })

    const byId = new Map(components.map((c) => [c.id as string, c.languages as readonly string[]]))
    expect(byId.get("root")).toEqual(["go", "ts"])
  })

  it("collects the files of a component root whose name is decomposed", async () => {
    const decomposed = "café".normalize("NFD")
    await writeFileAt("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n")
    await writeFileAt("package.json", JSON.stringify({ name: "root", private: true }))
    await writeFileAt(join("packages", decomposed, "package.json"), JSON.stringify({ name: "caf" }))
    await writeLanguage(join("packages", decomposed, "src"), ".go")

    const components = await detectComponents({ workspaceRoot: workRoot })

    expect(components).toHaveLength(1)
    expect(components[0]?.languages).toEqual(["go"])
  })
})
