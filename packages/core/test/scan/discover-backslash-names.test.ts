import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { type DiscoverOptions, discoverFiles } from "../../src"

const workspace = useScratchWorkspace("scan-discover-backslash")

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

  onPosix("takes an ignore pattern for it only with the backslash written twice", async () => {
    expect(
      (await discover(["src/v\\1/util.ts"], { ignore: ["src/v\\1/**"] })).unrepresentableFiles,
    ).toHaveLength(1)
    expect((await discover([], { ignore: ["src/v\\\\1/**"] })).unrepresentableFiles).toEqual([])
  })
})
