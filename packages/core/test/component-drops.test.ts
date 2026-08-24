import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { detectComponents } from "../src/index"

/**
 * Detection decides `Component.languages` by counting file extensions, and it used to count
 * files the workspace had excluded: it carried its own eight-pattern list where discovery has
 * twenty-six, and read no `.gitignore` at all. A vendored copy or a generated client then put a
 * language on a component that no Symbol in it is written in — a label that reaches the IR and
 * is compared against the next revision.
 *
 * The threshold is ten files and a five-percent share, so every fixture here writes enough of
 * one language to clear it and enough of another to be the thing under test.
 */

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
    // `out/` is one of the eighteen patterns detection's own list lacked — and it is where
    // `aburi scan` puts its own artefacts, so a second run counted the first run's output.
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
    // The reason the walk is one glob from the workspace root: `packages/app/fixtures/**`
    // matches nothing when matched against a walk rooted at `packages/app`, and `fixtures/**`
    // would then match both packages. `config.ignore` is documented workspace-root relative.
    await makeMonorepo()

    const components = await detectComponents({
      workspaceRoot: workRoot,
      ignore: ["packages/app/fixtures/**"],
    })

    const byId = new Map(components.map((c) => [c.id as string, c.languages as readonly string[]]))
    expect(byId.get("app")).toEqual(["ts"])
    expect(byId.get("other")).toEqual(["py", "ts"])
  })

  it("still counts only three levels below each component root", async () => {
    await makeMonorepo()
    // Four levels under `packages/app`, which is six from the workspace root — out of reach
    // whichever root the depth is measured from, and the reason the bucketing checks it.
    await writeLanguage(join("packages", "app", "a", "b", "c", "d"), ".go")

    const components = await detectComponents({ workspaceRoot: workRoot })

    const app = components.find((c) => (c.id as string) === "app")
    expect(app?.languages).toEqual(["py", "ts"])
  })

  it("collects the files of a component root whose name is decomposed", async () => {
    // The component root arrives NFC-normalized and the walk returns the filesystem's own
    // spelling, so the two only meet if the comparison normalizes.
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
