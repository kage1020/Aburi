import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { type DiscoverOptions, discoverFiles } from "../../src"

const workspace = useScratchWorkspace("scan-discover-unnameable")

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

describe("discoverFiles — a backslash, which no Document path can spell", () => {
  onPosix("reports the file instead of renaming it, and keeps walking", async () => {
    const result = await discover(["src/weird\\name.ts", "src/ok.ts"])

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.skipped).toEqual([])
    expect(result.unrepresentableFiles).toEqual([
      {
        fsPath: "src/weird\\name.ts",
        reason: "unspellable-name",
        unnameablePrefix: "src/weird\\name.ts",
      },
    ])
  })

  onPosix("blames the directory when the directory is what holds it", async () => {
    const result = await discover(["src/v\\1/util.ts", "src/v\\1/other.ts"])

    expect(result.unrepresentableFiles).toEqual([
      { fsPath: "src/v\\1/other.ts", reason: "unspellable-name", unnameablePrefix: "src/v\\1" },
      { fsPath: "src/v\\1/util.ts", reason: "unspellable-name", unnameablePrefix: "src/v\\1" },
    ])
  })

  onPosix("says nothing about one whose extension no plugin claims", async () => {
    const result = await discover(["notes\\1.txt", "src/ok.ts"])

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.unrepresentableFiles).toEqual([])
  })
})

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
})

describe("discoverFiles — an ignore pattern for a name no Document path can spell", () => {
  onPosix.each<[string, readonly string[], readonly string[], readonly string[]]>([
    [
      "a backslash only with the backslash written twice",
      ["src/v\\1/util.ts"],
      ["src/v\\1/**"],
      ["src/v\\\\1/**"],
    ],
    ["a name read as a drive as printed", ["a:b.ts", "d:data/x.ts"], [], ["a:b.ts", "d:data"]],
  ])("excludes %s", async (_, files, missing, matching) => {
    const unmatched = await discover(files, { ignore: missing })
    expect(unmatched.unrepresentableFiles).toHaveLength(files.length)
    expect((await discover([], { ignore: matching })).unrepresentableFiles).toEqual([])
  })
})
