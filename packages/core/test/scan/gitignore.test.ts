import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverFiles } from "../../src"

let workRoot: string

/** Every file in the fixture, and what `git check-ignore` says about each. */
const FIXTURE = [
  "gen/keep.ts",
  "gen/other.ts",
  "assets/keep.ts",
  "assets/drop.ts",
  "keep.spec.ts",
  "drop.spec.ts",
  "src/a.ts",
  "src/keepme/c.ts",
  "a[1].ts",
  "a1.ts",
] as const

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
].join("\n")

const KEPT_BY_GIT = ["a[1].ts", "assets/keep.ts", "keep.spec.ts", "src/a.ts", "src/keepme/c.ts"]

const COMPOSED = "src/café.ts".normalize("NFC")
const DECOMPOSED = "src/café.ts".normalize("NFD")

async function writeFileAt(rel: string, content = "1"): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

async function writeGitignore(...lines: readonly string[]): Promise<void> {
  await writeFile(join(workRoot, ".gitignore"), `${lines.join("\n")}\n`, "utf8")
}

async function discoverOrThrow(): Promise<unknown> {
  return await discoverFiles({ workspaceRoot: workRoot, languageExtensions: [".ts"] }).then(
    () => null,
    (error: unknown) => error,
  )
}

async function discover(options: { ignore?: readonly string[] } = {}): Promise<string[]> {
  const result = await discoverFiles({
    workspaceRoot: workRoot,
    languageExtensions: [".ts"],
    ...options,
  })
  expect(result.skipped).toEqual([])
  expect(result.unrepresentableFiles).toEqual([])
  return result.files.map((f) => f.path)
}

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-gitignore-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

describe("discoverFiles — .gitignore is decided the way git decides it", () => {
  beforeEach(async () => {
    for (const file of FIXTURE) await writeFileAt(file)
    await writeFile(join(workRoot, ".gitignore"), `${GITIGNORE}\n`, "utf8")
  })

  it("gives git's verdict on every file in the fixture", async () => {
    expect(await discover()).toEqual(KEPT_BY_GIT)
  })

  it("re-includes a file whose directory was never excluded", async () => {
    const found = await discover()
    expect(found).toContain("assets/keep.ts")
    expect(found).not.toContain("assets/drop.ts")
  })

  it("re-includes nothing under a directory that was excluded outright", async () => {
    const found = await discover()
    expect(found).not.toContain("gen/keep.ts")
    expect(found).not.toContain("gen/other.ts")
  })

  it("lets a negated directory put its whole subtree back", async () => {
    expect(await discover()).toEqual(expect.arrayContaining(["src/a.ts", "src/keepme/c.ts"]))
  })

  it("reads brackets as a character class, in both directions", async () => {
    const found = await discover()
    expect(found).toContain("a[1].ts")
    expect(found).not.toContain("a1.ts")
  })

  it("records nothing for a file it excluded", async () => {
    const result = await discoverFiles({ workspaceRoot: workRoot, languageExtensions: [".ts"] })
    expect(result.skipped).toEqual([])
    expect(result.files.map((f) => f.path)).toEqual(KEPT_BY_GIT)
  })
})

describe("discoverFiles — .gitignore matching is case-sensitive", () => {
  it("does not let a rule spelled with a capital take the lowercase file", async () => {
    await writeFileAt("dist-out/x.ts")
    await writeFileAt("a.log.ts")
    await writeFileAt("src/a.ts")
    await writeGitignore("Dist-Out/", "*.LOG.ts")

    expect(await discover()).toEqual(["a.log.ts", "dist-out/x.ts", "src/a.ts"])
  })

  it("does not let a negation spelled with a capital rescue the lowercase file", async () => {
    // The same fold in the other direction: a file git ignores would come back.
    await writeFileAt("emitted/keep.ts")
    await writeFileAt("src/a.ts")
    await writeGitignore("emitted/*", "!emitted/Keep.ts")

    expect(await discover()).toEqual(["src/a.ts"])
  })

  it("matches only the case a rule is spelled in", async () => {
    await writeFileAt("Foo.ts")
    await writeFileAt("src/a.ts")

    await writeGitignore("Foo.ts")
    expect(await discover()).toEqual(["src/a.ts"])

    await writeGitignore("foo.ts")
    expect(await discover()).toEqual(["Foo.ts", "src/a.ts"])
  })
})

describe("discoverFiles — what a .gitignore negation cannot reach", () => {
  it("cannot rescue a file config.ignore excluded", async () => {
    await writeFileAt("src/a.ts")
    await writeFileAt("src/local.ts")
    await writeGitignore("!src/local.ts")

    expect(await discover({ ignore: ["src/local.ts"] })).toEqual(["src/a.ts"])
  })

  it("cannot rescue a file a core drop pattern excluded", async () => {
    await writeFileAt("src/a.ts")
    await writeFileAt("dist/bundle.ts")
    await writeGitignore("!dist/bundle.ts")

    expect(await discover()).toEqual(["src/a.ts"])
  })

  it("reads a .gitignore below the workspace root", async () => {
    await writeFileAt("src/a.ts")
    await writeFileAt("src/nested/x.ts")
    await writeFile(join(workRoot, "src/nested/.gitignore"), "x.ts\n", "utf8")
    await writeGitignore("# the root file excludes nothing")

    expect(await discover()).toEqual(["src/a.ts"])
  })
})

describe("discoverFiles — the lines a .gitignore is allowed to contain", () => {
  it("skips comments and blank lines, keeps CRLF and trailing spaces straight", async () => {
    await writeFileAt("src/a.ts")
    await writeFileAt("src/tmp.ts")
    await writeFileAt("#hash.ts")
    await writeFile(
      join(workRoot, ".gitignore"),
      "# a comment\r\n\r\n   \r\nsrc/tmp.ts   \r\n\\#hash.ts\r\n",
      "utf8",
    )

    expect(await discover()).toEqual(["src/a.ts"])
  })

  it("treats a .gitignore that excludes nothing as no .gitignore at all", async () => {
    await writeFileAt("src/a.ts")
    await writeGitignore("# nothing here", "")

    expect(await discover()).toEqual(["src/a.ts"])
  })

  it("names the file when a line is one the matcher will not take", async () => {
    await writeFileAt("src/a.ts")
    await writeGitignore("a".repeat(5_000))

    const thrown = await discoverOrThrow()

    expect((thrown as { code?: string }).code).toBe("scan-gitignore-unreadable")
    expect((thrown as Error).message).toContain(".gitignore")
  })

  it("takes a rule of exactly the maximum length, and refuses one character more", async () => {
    await writeFileAt("src/a.ts")
    await writeGitignore("a".repeat(4_096))

    expect(await discover()).toEqual(["src/a.ts"])

    await writeGitignore("a".repeat(4_097))
    const thrown = await discoverOrThrow()

    expect((thrown as { code?: string }).code).toBe("scan-gitignore-unreadable")
  })

  it("names the file when a rule inside the limit is one the engine refuses", async () => {
    await writeFileAt("src/a.ts")
    await writeGitignore("a/[/b")

    const thrown = await discoverOrThrow()

    expect((thrown as { code?: string }).code).toBe("scan-gitignore-unreadable")
    expect((thrown as Error).message).toContain("line 1")
  })
})

const onCollidingFs = it.skipIf(process.platform === "darwin")

describe("discoverFiles — which spelling the matcher is asked about, and when", () => {
  it("matches the spelling on disk, not the one the Document would record", async () => {
    await writeFileAt(DECOMPOSED)
    await writeFileAt("src/a.ts")
    await writeGitignore(DECOMPOSED)

    expect(await discover()).toEqual(["src/a.ts"])
  })

  it("excludes a file before the path it could never take is decided", async () => {
    await writeFileAt("src/v#1/emitted.ts")
    await writeFileAt("src/a.ts")
    await writeGitignore("src/v#1/")

    const result = await discoverFiles({ workspaceRoot: workRoot, languageExtensions: [".ts"] })

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts"])
    expect(result.skipped).toEqual([])
  })

  it("excludes a file before its size is looked at", async () => {
    await writeFileAt("gen/big.ts", "x".repeat(64))
    await writeFileAt("src/a.ts")
    await writeGitignore("gen/")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      maxFileSizeBytes: 8,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts"])
    expect(result.skipped).toEqual([])
  })

  onCollidingFs("excludes a claimant before the group it would have collided with", async () => {
    await writeFileAt(DECOMPOSED)
    await writeFileAt(COMPOSED)
    await writeGitignore(DECOMPOSED)

    const result = await discoverFiles({ workspaceRoot: workRoot, languageExtensions: [".ts"] })

    expect(result.files.map((f) => f.path)).toEqual([COMPOSED])
    expect(result.unrepresentableFiles).toEqual([])
  })
})
