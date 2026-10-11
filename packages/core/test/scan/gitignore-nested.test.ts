import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { discoverFiles } from "../../src"

const workspace = useScratchWorkspace("gitignore-nested")

/** A rule no regex engine takes, so a run that read the file would end. */
const UNUSABLE = "a".repeat(5_000)

/** A `.gitignore` in `directory` (`""` for the workspace root). */
async function gitignoreIn(directory: string, ...lines: readonly string[]): Promise<void> {
  await workspace.writeSource(join(directory, ".gitignore"), `${lines.join("\n")}\n`)
}

async function discover(
  files: readonly string[],
  options: { respectGitignore?: boolean; ignore?: readonly string[] } = {},
): Promise<string[]> {
  for (const file of files) await workspace.writeSource(file, "1")
  const result = await discoverFiles({
    workspaceRoot: workspace.root,
    languageExtensions: [".ts"],
    ...options,
  })
  expect(result.skipped).toEqual([])
  expect(result.unrepresentableFiles).toEqual([])
  return result.files.map((f) => f.path)
}

describe("a .gitignore in every directory", () => {
  it.each<[string, [directory: string, ...rules: string[]][], string[], string[]]>([
    [
      "honours a package's own file, and only under that package",
      [["pkg", "fixtures/"]],
      ["pkg/fixtures/a.ts", "other/fixtures/a.ts"],
      ["other/fixtures/a.ts"],
    ],
    [
      "anchors a nested pattern to the directory that declared it",
      [["pkg", "/local.ts"]],
      ["pkg/local.ts", "pkg/sub/local.ts", "local.ts"],
      ["local.ts", "pkg/sub/local.ts"],
    ],
    [
      "reads a file two directories down",
      [["a/b", "fixtures/"]],
      ["a/b/fixtures/x.ts", "a/fixtures/x.ts"],
      ["a/fixtures/x.ts"],
    ],
    [
      "lets a deeper negation put a file back",
      [
        ["", "*.ts"],
        ["pkg", "!keep.ts"],
      ],
      ["pkg/keep.ts", "pkg/other.ts"],
      ["pkg/keep.ts"],
    ],
    [
      "lets a deeper exclusion take one away",
      [
        ["", "!*.ts"],
        ["pkg", "keep.ts"],
      ],
      ["pkg/keep.ts", "pkg/other.ts"],
      ["pkg/other.ts"],
    ],
    [
      "takes the deepest opinion when three files disagree",
      [
        ["", "*.ts"],
        ["pkg", "!keep.ts"],
        ["pkg/sub", "keep.ts"],
      ],
      ["pkg/keep.ts", "pkg/sub/keep.ts"],
      ["pkg/keep.ts"],
    ],
    [
      "re-includes nothing under a directory the root excluded outright",
      [
        ["", "generated/"],
        ["generated", "!g.ts"],
      ],
      ["generated/g.ts"],
      [],
    ],
    [
      "re-includes under a directory whose contents, not the directory, were excluded",
      [
        ["", "generated/*"],
        ["generated", "!g.ts"],
      ],
      ["generated/g.ts", "generated/x.ts"],
      ["generated/g.ts"],
    ],
    [
      "does not let two nested files together rescue a file under an excluded directory",
      [
        ["", "gen/"],
        ["gen", "!sub/"],
        ["gen/sub", "!x.ts"],
      ],
      ["gen/sub/x.ts", "gen/sub/y.ts", "keep.ts"],
      ["keep.ts"],
    ],
    [
      "does not let a directory's own file re-include the directory",
      [
        ["", "pkg/"],
        ["pkg", "!keep.ts"],
      ],
      ["pkg/keep.ts"],
      [],
    ],
  ])("%s", async (_label, gitignores, files, kept) => {
    for (const [directory, ...rules] of gitignores) await gitignoreIn(directory, ...rules)
    expect(await discover(files)).toEqual(kept)
  })

  it("governs a directory whose name is decomposed", async () => {
    const directory = "café".normalize("NFD")
    await gitignoreIn(directory, "drop.ts")
    expect(await discover([`${directory}/drop.ts`, `${directory}/keep.ts`])).toEqual([
      `${"café".normalize("NFC")}/keep.ts`,
    ])
  })
})

describe("a .gitignore the walk never reaches is not read", () => {
  it.each<[string, string, { ignore?: readonly string[] }]>([
    ["inside .git", ".git", {}],
    ["under a directory a core drop pattern removed", "node_modules/pkg", {}],
    ["under a directory config.ignore removed", "private", { ignore: ["private/**"] }],
  ])("never opens one %s", async (_label, directory, options) => {
    await gitignoreIn(directory, UNUSABLE)
    expect(await discover([`${directory}/a.ts`, "keep.ts"], options)).toEqual(["keep.ts"])
  })

  it("reads none at any depth when respectGitignore is off", async () => {
    await gitignoreIn("", "root.ts")
    await gitignoreIn("pkg", UNUSABLE)
    expect(await discover(["root.ts", "pkg/a.ts"], { respectGitignore: false })).toEqual([
      "pkg/a.ts",
      "root.ts",
    ])
  })

  // Creating a symlink on Windows needs a privilege an ordinary test run does not have.
  it.skipIf(process.platform === "win32")(
    "does not follow a symlink, resolvable or not",
    async () => {
      await workspace.writeSource("rules.txt", "drop.ts\n")
      for (const [directory, target] of [
        ["resolvable", join(workspace.root, "rules.txt")],
        ["dangling", join(workspace.root, "nothing-here")],
      ] as const) {
        await workspace.writeSource(`${directory}/drop.ts`, "1")
        await symlink(target, join(workspace.root, directory, ".gitignore"))
      }

      expect(await discover([])).toEqual(["dangling/drop.ts", "resolvable/drop.ts"])
    },
  )
})
