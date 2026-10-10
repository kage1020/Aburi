import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { type DiscoverOptions, discoverFiles } from "../../src"

const workspace = useScratchWorkspace("scan-discover-unicode")

async function discover(
  files: Readonly<Record<string, string>>,
  options: Pick<DiscoverOptions, "languageExtensions" | "maxFileSizeBytes"> = {},
) {
  for (const [file, content] of Object.entries(files)) await workspace.writeSource(file, content)
  return discoverFiles({
    workspaceRoot: workspace.root,
    languageExtensions: [".ts"],
    respectGitignore: false,
    ...options,
  })
}

const DECOMPOSED_CAFE = "src/caf\u0065\u0301.ts"
const COMPOSED_CAFE = "src/caf\u00e9.ts"

describe("discoverFiles — the extension filter reads the filesystem's spelling", () => {
  it.each([
    ["a composed declaration against a decomposed filename", "src/a.ts\u0301", ".t\u015b"],
    ["a decomposed declaration against a composed filename", "src/a.t\u015b", ".ts\u0301"],
  ])("matches %s", async (_label, file, extension) => {
    const result = await discover({ [file]: "1" }, { languageExtensions: [extension] })
    expect(result.files.map((f) => f.path)).toEqual(["src/a.t\u015b"])
    expect(result.skipped).toEqual([])
  })
})

describe("discoverFiles — a name the filesystem and the Document spell differently", () => {
  it.each([
    [
      "records the normalized name and opens the file by the one on disk",
      DECOMPOSED_CAFE,
      COMPOSED_CAFE,
    ],
    ["leaves the two the same for a name already in NFC", "src/plain.ts", "src/plain.ts"],
  ])("%s", async (_label, onDisk, recorded) => {
    const result = await discover({ [onDisk]: "1234" })
    expect(result.files).toEqual([{ path: recorded, fsPath: onDisk, size: 4 }])
    expect(result.skipped).toEqual([])
  })
})

const onCollidingFs = it.skipIf(process.platform === "darwin")

describe("discoverFiles — two spellings that claim one Document path", () => {
  onCollidingFs("withdraws every claimant, and records them as colliding", async () => {
    const result = await discover({
      [DECOMPOSED_CAFE]: "1",
      [COMPOSED_CAFE]: "22",
      "src/ok.ts": "1",
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.skipped).toEqual([])
    expect(result.unrepresentableFiles).toEqual([
      { fsPath: DECOMPOSED_CAFE, reason: "colliding-spelling", documentPath: COMPOSED_CAFE },
      { fsPath: COMPOSED_CAFE, reason: "colliding-spelling", documentPath: COMPOSED_CAFE },
    ])
  })

  onCollidingFs("holds a group of three, since nothing about the rule caps it at two", async () => {
    const result = await discover({
      "src/b\u1ec7.ts": "1",
      "src/b\u0065\u0323\u0302.ts": "22",
      "src/b\u1eb9\u0302.ts": "333",
    })

    expect(result.unrepresentableFiles).toHaveLength(3)
    for (const entry of result.unrepresentableFiles) {
      expect(entry.reason === "colliding-spelling" && entry.documentPath).toBe("src/b\u1ec7.ts")
    }
  })

  onCollidingFs(
    "withdraws a claimant that would otherwise have been skipped for its size",
    async () => {
      const result = await discover(
        { [DECOMPOSED_CAFE]: "12345", [COMPOSED_CAFE]: "1" },
        { maxFileSizeBytes: 2 },
      )

      expect(result.files).toEqual([])
      expect(result.skipped).toEqual([])
      expect(result.unrepresentableFiles).toHaveLength(2)
    },
  )

  onCollidingFs("withdraws a pair whose Document path no Symbol id could hold", async () => {
    const result = await discover({
      "src/v#1/caf\u0065\u0301.ts": "1",
      "src/v#1/caf\u00e9.ts": "22",
    })

    expect(result.skipped).toEqual([])
    expect(result.files).toEqual([])
    expect(result.unrepresentableFiles.map((f) => [f.fsPath, f.reason])).toEqual([
      ["src/v#1/caf\u0065\u0301.ts", "colliding-spelling"],
      ["src/v#1/caf\u00e9.ts", "colliding-spelling"],
    ])
  })

  onCollidingFs("leaves no Document path claimed twice, whichever arm produced it", async () => {
    const result = await discover(
      {
        [DECOMPOSED_CAFE]: "1",
        [COMPOSED_CAFE]: "22",
        "src/v#1/na\u0065\u0301.ts": "1",
        "src/v#1/na\u00e9.ts": "22",
        "src/big\u0065\u0301.ts": "1234567",
        "src/big\u00e9.ts": "1",
        "src/ok.ts": "1",
      },
      { maxFileSizeBytes: 4 },
    )

    expect([...result.files, ...result.skipped].map((entry) => entry.path)).toEqual(["src/ok.ts"])
  })
})
