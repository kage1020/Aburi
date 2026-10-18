import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { type DiscoverOptions, discoverFiles } from "../../src"

const workspace = useScratchWorkspace("scan-discover-drive")

async function discover(files: readonly string[], options: Pick<DiscoverOptions, "ignore"> = {}) {
  for (const file of files) await workspace.writeSource(file, "1")
  return discoverFiles({
    workspaceRoot: workspace.root,
    languageExtensions: [".ts"],
    respectGitignore: false,
    ...options,
  })
}

const onPosix = it.skipIf(process.platform === "win32")

describe("discoverFiles — a top-level name a Document path would read as a Windows drive", () => {
  onPosix.each<[string, readonly string[], string]>([
    ["a file", ["a:b.ts"], "a:b.ts"],
    ["every file under a directory", ["d:data/x.ts", "d:data/y.ts"], "d:data"],
    ["the file under a directory named by the drive alone", ["x:/y.ts"], "x:"],
    ["a file whose name normalizes to one", ["\u212A:notes.ts"], "\u212A:notes.ts"],
  ])("reports %s instead of ending the walk, and keeps walking", async (_, names, prefix) => {
    const result = await discover([...names, "src/ok.ts"])

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.skipped).toEqual([])
    expect(result.unrepresentableFiles).toEqual(
      names.map((fsPath) => ({
        fsPath,
        reason: "drive-shaped-name",
        unnameablePrefix: prefix,
      })),
    )
  })

  onPosix.each([
    ["ab:notes.ts", "ab:notes.ts"],
    ["src/x:y.ts", "x:y.ts"],
  ])("records %s, whose colon is not a drive's, as unroutable", async (path, segment) => {
    const result = await discover([path])

    expect(result.unrepresentableFiles).toEqual([])
    expect(result.skipped).toEqual([
      {
        path,
        reason: "unroutable",
        detail: expect.stringContaining(`its path segment "${segment}" contains ":"`),
      },
    ])
  })

  onPosix("takes an ignore pattern for it as printed", async () => {
    expect((await discover(["a:b.ts", "d:data/x.ts"])).unrepresentableFiles).toHaveLength(2)
    const ignored = await discover([], { ignore: ["a:b.ts", "d:data/**"] })
    expect(ignored.unrepresentableFiles).toEqual([])
  })
})
