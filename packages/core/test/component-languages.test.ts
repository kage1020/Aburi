import { describe, expect, it } from "vitest"
import { detectComponents } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-component-languages")

/** A single-project workspace: no manager markers, so the root itself is the one component. */
async function languagesOfRoot(
  options: { ignore?: readonly string[]; respectGitignore?: boolean } = {},
): Promise<readonly string[]> {
  const components = await detectComponents({ workspaceRoot: tree.root, ...options })
  expect(components).toHaveLength(1)
  return components[0]?.languages ?? []
}

async function languagesById(
  options: { ignore?: readonly string[] } = {},
): Promise<Map<string, readonly string[]>> {
  const components = await detectComponents({ workspaceRoot: tree.root, ...options })
  return new Map(components.map((c) => [c.id as string, c.languages as readonly string[]]))
}

describe("the language census", () => {
  it.each([
    [9, 12, ["ts"]],
    [10, 12, ["py", "ts"]],
    [10, 200, ["ts"]],
    [11, 200, ["py", "ts"]],
  ])("with %i .py files beside %i .ts files counts %j", async (py, ts, languages) => {
    await tree.writeLanguageFiles("src", ".ts", ts)
    await tree.writeLanguageFiles("scripts", ".py", py)

    expect(await languagesOfRoot()).toEqual(languages)
  })

  it("reads every extension of a language as that language", async () => {
    await tree.writeLanguageFiles("src", ".mjs", 6)
    await tree.writeLanguageFiles("lib", ".cjs", 6)

    expect(await languagesOfRoot()).toEqual(["js"])
  })
})

describe("detection drops what discovery drops", () => {
  it("does not count a directory only the shared core list names", async () => {
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writeLanguageFiles("out", ".py")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })

  it("does not count a dot-directory", async () => {
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writeLanguageFiles(".venv", ".py")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })

  it("does not count a tree the workspace git-ignores", async () => {
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writeLanguageFiles("generated", ".py")
    await tree.writeSource(".gitignore", "generated/\n")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })

  it("honours a nested .gitignore, as discovery does", async () => {
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writeLanguageFiles("src/vendored", ".py")
    await tree.writeSource("src/.gitignore", "vendored/\n")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })

  it("counts the git-ignored files again when respectGitignore is off", async () => {
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writeLanguageFiles("generated", ".py")
    await tree.writeSource(".gitignore", "generated/\n")

    expect(await languagesOfRoot({ respectGitignore: false })).toEqual(["py", "ts"])
  })

  it("takes the caller's ignore globs", async () => {
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writeLanguageFiles("fixtures", ".py")

    expect(await languagesOfRoot({ ignore: ["fixtures/**"] })).toEqual(["ts"])
  })

  it("leaves the ts fallback when everything a component holds was excluded", async () => {
    // `Component.languages` is `minItems: 1` on the wire, so detection cannot hand back none.
    await tree.writeLanguageFiles("generated", ".py")
    await tree.writeSource(".gitignore", "generated/\n")

    expect(await languagesOfRoot()).toEqual(["ts"])
  })
})

describe("what the drop decision is relative to", () => {
  it("reads an ignore glob against the workspace root, not each component root", async () => {
    await tree.writePnpmWorkspace("packages/*")
    await tree.writePackage(".", { name: "root", private: true })
    for (const name of ["app", "other"]) {
      await tree.writePackage(`packages/${name}`, { name })
      await tree.writeLanguageFiles(`packages/${name}/src`, ".ts")
      await tree.writeLanguageFiles(`packages/${name}/fixtures`, ".py")
    }

    const byId = await languagesById({ ignore: ["packages/app/fixtures/**"] })

    expect(byId.get("app")).toEqual(["ts"])
    expect(byId.get("other")).toEqual(["py", "ts"])
  })

  it("counts three levels below each root, whichever root, with roots at different depths", async () => {
    await tree.writePnpmWorkspace("packages/*", "packages/app/inner/*")
    await tree.writePackage(".", { name: "root", private: true })
    await tree.writePackage("packages/app", { name: "app" })
    await tree.writeLanguageFiles("packages/app/src", ".ts")
    // Exactly three directories below `packages/app` — the last depth that counts.
    await tree.writeLanguageFiles("packages/app/a/b/c", ".go")
    // Four below it: the first that does not.
    await tree.writeLanguageFiles("packages/app/x/y/z/w", ".rb")
    await tree.writePackage("packages/app/inner/deep", { name: "deep" })
    await tree.writeLanguageFiles("packages/app/inner/deep/p/q/r", ".rs")

    const byId = await languagesById()

    expect(byId.get("app")).toEqual(["go", "ts"])
    expect(byId.get("deep")).toEqual(["rs"])
  })

  it("holds the depth limit for the workspace root when it is one root among several", async () => {
    await tree.writeJson("nx.json", { version: 2 })
    await tree.writeJson("project.json", { name: "root" })
    await tree.writePackage(".", { name: "root", private: true })
    await tree.writeLanguageFiles("src", ".ts")
    await tree.writeJson("packages/app/project.json", { name: "app" })
    await tree.writePackage("packages/app", { name: "app" })
    await tree.writeLanguageFiles("packages/app/src", ".ts")
    await tree.writeLanguageFiles("a/b/c", ".go")
    await tree.writeLanguageFiles("x/y/z/w", ".rb")

    expect((await languagesById()).get("root")).toEqual(["go", "ts"])
  })

  it("collects the files of a component root whose name is decomposed", async () => {
    const decomposed = "café".normalize("NFD")
    await tree.writePnpmWorkspace("packages/*")
    await tree.writePackage(".", { name: "root", private: true })
    await tree.writePackage(`packages/${decomposed}`, { name: "caf" })
    await tree.writeLanguageFiles(`packages/${decomposed}/src`, ".go")

    const components = await detectComponents({ workspaceRoot: tree.root })

    expect(components).toHaveLength(1)
    expect(components[0]?.languages).toEqual(["go"])
  })
})
