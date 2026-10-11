import { chmod, symlink } from "node:fs/promises"
import { join } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { type DiscoverOptions, discoverFiles } from "../../src"

const workspace = useScratchWorkspace("scan-discover")

async function discover(
  files: readonly string[],
  options: Omit<DiscoverOptions, "workspaceRoot"> = {},
) {
  for (const file of files) await workspace.writeSource(file, "1")
  return discoverFiles({
    workspaceRoot: workspace.root,
    languageExtensions: [".ts"],
    respectGitignore: false,
    ...options,
  })
}

describe("discoverFiles", () => {
  it("lists every file as a POSIX path relative to the root, sorted", async () => {
    const result = await discover(["src/nested/c.ts", "src/b.ts", "src/a.ts"])

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/nested/c.ts"])
    expect(result.skipped).toEqual([])
  })

  it.each<[string, string[], Omit<DiscoverOptions, "workspaceRoot">]>([
    [
      "what the core drop patterns name",
      ["node_modules/foo/index.ts", "dist/build.ts", "src/types.d.ts", "src/view.generated.ts"],
      {},
    ],
    ["what config.ignore names", ["src/generated.ts"], { ignore: ["src/generated.ts"] }],
    [
      "what a language plugin's drop patterns name",
      ["src/lib.ts"],
      { langDropPatterns: ["**/lib.ts"] },
    ],
    [
      "files under a dot-directory, .git among them",
      [".git/hooks/pre-commit.ts", ".cache/x.ts"],
      {},
    ],
    ["files whose extension no plugin claims", ["src/b.py", "README.md"], {}],
  ])("leaves out %s", async (_label, dropped, options) => {
    const result = await discover(["src/keep.ts", ...dropped], options)
    expect(result.files.map((f) => f.path)).toEqual(["src/keep.ts"])
    expect(result.skipped).toEqual([])
  })

  it("takes every extension when no language narrows them", async () => {
    const result = await discover(["src/a.ts", "src/b.md"], { languageExtensions: [] })
    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.md"])
  })

  it("skips a file over maxFileSizeBytes, stating its size against the cap", async () => {
    await workspace.writeSource("src/huge.ts", "x".repeat(2048))
    const result = await discover(["src/small.ts"], { maxFileSizeBytes: 1024 })

    expect(result.files.map((f) => f.path)).toEqual(["src/small.ts"])
    expect(result.skipped).toEqual([
      { path: "src/huge.ts", reason: "over-size", detail: "2048 > 1024" },
    ])
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "ends the run with the operating system's own error when a stat fails for the machine's reasons",
    async () => {
      await workspace.writeSource("src/sealed/a.ts", "1")
      const sealed = join(workspace.root, "src", "sealed")
      await chmod(sealed, 0o444)
      try {
        const error = await errorFrom(Error, () => discover(["src/plain.ts"]))
        expect((error as { code?: string }).code).toBe("EACCES")
        expect(error.message).toContain(join(sealed, "a.ts"))
      } finally {
        await chmod(sealed, 0o755)
      }
    },
  )
})

describe("discoverFiles — symlinks are not followed", () => {
  const outside = useScratchWorkspace("scan-discover-outside")

  async function discoverAmongLinks(): Promise<string[]> {
    const result = await discover([])
    expect(result.skipped).toEqual([])
    expect(result.unrepresentableFiles).toEqual([])
    return result.files.map((f) => f.path)
  }

  it("does not walk through a link to a directory, in the workspace, out of it or back up", async () => {
    await outside.writeSource("o.ts", "1")
    await workspace.writeSource("src/a.ts", "1")
    // A junction is a directory link on Windows that needs no privilege to create, and the walk
    // reads it as a link, so this runs everywhere.
    await symlink(join(workspace.root, "src"), join(workspace.root, "shared"), "junction")
    await symlink(outside.root, join(workspace.root, "src", "ext"), "junction")
    await symlink(workspace.root, join(workspace.root, "src", "loop"), "junction")

    expect(await discoverAmongLinks()).toEqual(["src/a.ts"])
  })

  // Creating a link to a file on Windows needs a privilege an ordinary test run does not have.
  it.skipIf(process.platform === "win32")("does not list a link to a file", async () => {
    await outside.writeSource("o.ts", "1")
    await workspace.writeSource("src/a.ts", "1")
    await symlink("a.ts", join(workspace.root, "src", "b.ts"))
    await symlink(join(outside.root, "o.ts"), join(workspace.root, "src", "o.ts"))
    await symlink("nowhere.ts", join(workspace.root, "src", "dangling.ts"))

    expect(await discoverAmongLinks()).toEqual(["src/a.ts"])
  })
})
