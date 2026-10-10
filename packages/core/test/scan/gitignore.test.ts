import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { discoverFiles } from "../../src"

const workspace = useScratchWorkspace("gitignore")

async function writeGitignore(...lines: readonly string[]): Promise<void> {
  await workspace.writeSource(".gitignore", `${lines.join("\n")}\n`)
}

async function discover(
  files: readonly string[],
  options: { ignore?: readonly string[]; maxFileSizeBytes?: number } = {},
) {
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

/** Every file in the fixture, whether `git check-ignore` keeps it under `GITIGNORE`, and why. */
const FIXTURE: readonly [file: string, keptByGit: boolean, why: string][] = [
  ["gen/keep.ts", false, "a negation cannot re-include under a directory excluded outright"],
  ["gen/other.ts", false, "under a directory excluded outright"],
  ["assets/keep.ts", true, "re-included where only the directory's contents were excluded"],
  ["assets/drop.ts", false, "matched by assets/*"],
  ["keep.spec.ts", true, "re-included after *.spec.ts"],
  ["drop.spec.ts", false, "matched by *.spec.ts"],
  ["src/a.ts", true, "under a directory a negation put back"],
  ["src/keepme/c.ts", true, "under a subtree a negation put back"],
  ["a[1].ts", true, "brackets are a character class, so a[1].ts names a1.ts and not this file"],
  ["a1.ts", false, "matched by the character class"],
]

const GITIGNORE = [
  "gen/",
  "!gen/keep.ts",
  "assets/*",
  "!assets/keep.ts",
  "*.spec.ts",
  "!keep.spec.ts",
  "src/",
  "!src/",
  "!src/keepme/",
  "a[1].ts",
]

describe("discoverFiles — .gitignore is decided the way git decides it", () => {
  it("gives git's verdict on every file in the fixture", async () => {
    await writeGitignore(...GITIGNORE)
    const kept = FIXTURE.filter(([, keptByGit]) => keptByGit).map(([file]) => file)
    kept.sort()

    expect(await discover(FIXTURE.map(([file]) => file))).toEqual(kept)
  })

  it.each<[string, string[], string[], string[]]>([
    [
      "a rule spelled with a capital takes no lowercase file",
      ["Dist-Out/", "*.LOG.ts"],
      ["dist-out/x.ts", "a.log.ts", "src/a.ts"],
      ["a.log.ts", "dist-out/x.ts", "src/a.ts"],
    ],
    [
      "a negation spelled with a capital rescues no lowercase file",
      ["emitted/*", "!emitted/Keep.ts"],
      ["emitted/keep.ts", "src/a.ts"],
      ["src/a.ts"],
    ],
    ["a rule takes the file spelled its way", ["Foo.ts"], ["Foo.ts", "src/a.ts"], ["src/a.ts"]],
    [
      "a rule leaves a file spelled another way",
      ["foo.ts"],
      ["Foo.ts", "src/a.ts"],
      ["Foo.ts", "src/a.ts"],
    ],
  ])("matches case-sensitively: %s", async (_label, rules, files, kept) => {
    await writeGitignore(...rules)
    expect(await discover(files)).toEqual(kept)
  })

  it("skips comments and blank lines, and reads CRLF and trailing spaces as git does", async () => {
    await workspace.writeSource(
      ".gitignore",
      "# a comment\r\n\r\n   \r\nsrc/tmp.ts   \r\n\\#hash.ts\r\n",
    )
    expect(await discover(["src/a.ts", "src/tmp.ts", "#hash.ts"])).toEqual(["src/a.ts"])
  })

  it("reads a directory named .gitignore as no rules at all", async () => {
    await mkdir(join(workspace.root, ".gitignore"))
    expect(await discover(["src/a.ts"])).toEqual(["src/a.ts"])
  })

  it("does not read .git/info/exclude, which is per-clone rather than committed", async () => {
    await workspace.writeSource(".git/info/exclude", "a.ts\n")
    expect(await discover(["a.ts"])).toEqual(["a.ts"])
  })
})

describe("discoverFiles — what a .gitignore negation cannot reach", () => {
  it.each<[string, string, { ignore?: readonly string[] }]>([
    ["config.ignore", "src/local.ts", { ignore: ["src/local.ts"] }],
    ["a core drop pattern", "dist/bundle.ts", {}],
  ])("cannot rescue a file %s excluded", async (_label, file, options) => {
    await writeGitignore(`!${file}`)
    expect(await discover(["src/a.ts", file], options)).toEqual(["src/a.ts"])
  })
})

describe("discoverFiles — which spelling the matcher is asked about, and when", () => {
  const COMPOSED = "src/café.ts".normalize("NFC")
  const DECOMPOSED = "src/café.ts".normalize("NFD")

  it("matches the spelling on disk, not the one the Document would record", async () => {
    await writeGitignore(DECOMPOSED)
    expect(await discover([DECOMPOSED, "src/a.ts"])).toEqual(["src/a.ts"])
  })

  it("excludes a file before deciding that no Symbol id could name it", async () => {
    await writeGitignore("src/v#1/")
    expect(await discover(["src/v#1/emitted.ts", "src/a.ts"])).toEqual(["src/a.ts"])
  })

  it("excludes a file before looking at its size", async () => {
    await writeGitignore("gen/")
    await workspace.writeSource("gen/big.ts", "x".repeat(64))
    expect(await discover(["src/a.ts"], { maxFileSizeBytes: 8 })).toEqual(["src/a.ts"])
  })

  it.skipIf(process.platform === "darwin")(
    "excludes a claimant before the group it would have collided with",
    async () => {
      await writeGitignore(DECOMPOSED)
      expect(await discover([DECOMPOSED, COMPOSED])).toEqual([COMPOSED])
    },
  )
})
