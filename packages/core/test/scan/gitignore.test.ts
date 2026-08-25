import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverFiles } from "../../src"

/**
 * `.gitignore` is decided the way git decides it, and every expectation below was taken from
 * `git check-ignore` on the same fixture rather than reasoned about.
 *
 * Two of git's rules are the ones a hand-rolled translation gets wrong, and they pull in
 * opposite directions. A later `!rule` re-includes — `assets/*` followed by `!assets/keep.ts`
 * keeps that file — but nothing re-includes under a directory that was excluded outright, so
 * `gen/` followed by `!gen/keep.ts` keeps nothing: git never descends into `gen/` and the file
 * is not there to be rescued.
 *
 * The verdicts are hardcoded rather than compared against a `git` subprocess at test time.
 * A test that shells out proves the two agree on whatever git is installed and says nothing
 * about what either does; these say what the answer is, and a future version of the matcher
 * that changes one of them has to change a line here to do it.
 */

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

/**
 * `café.ts` in both compositions. Identical on screen and different bytes on disk, so the two
 * are derived rather than typed: whichever form this source file is stored in, `normalize`
 * pins each constant to the one it is named for.
 */
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
    // `assets/*` excludes the contents, not the directory, so git walks in and the later
    // `!assets/keep.ts` is reached. This file used to be dropped.
    const found = await discover()
    expect(found).toContain("assets/keep.ts")
    expect(found).not.toContain("assets/drop.ts")
  })

  it("re-includes nothing under a directory that was excluded outright", async () => {
    // `gen/` excludes the directory itself. Git does not descend, so `!gen/keep.ts` has
    // nothing to act on — the one shape the old glob translation happened to get right.
    const found = await discover()
    expect(found).not.toContain("gen/keep.ts")
    expect(found).not.toContain("gen/other.ts")
  })

  it("lets a negated directory put its whole subtree back", async () => {
    expect(await discover()).toEqual(expect.arrayContaining(["src/a.ts", "src/keepme/c.ts"]))
  })

  it("reads brackets as a character class, in both directions", async () => {
    // `a[1].ts` is a class matching `a1.ts`, which is excluded. The file actually named
    // `a[1].ts` is not what the pattern matches, and used to be dropped anyway.
    const found = await discover()
    expect(found).toContain("a[1].ts")
    expect(found).not.toContain("a1.ts")
  })

  it("records nothing for a file it excluded", async () => {
    // A `.gitignore`d file was never a candidate: it does not appear in `skipped`, it is not
    // counted, and integrity #21 ties `stats.skippedFiles`'s length to the difference. The
    // two `expect`s in `discover` carry this for every case above; this one names it.
    const result = await discoverFiles({ workspaceRoot: workRoot, languageExtensions: [".ts"] })
    expect(result.skipped).toEqual([])
    expect(result.files.map((f) => f.path)).toEqual(KEPT_BY_GIT)
  })
})

describe("discoverFiles — .gitignore matching is case-sensitive", () => {
  // Git folds case only where `core.ignoreCase` says so — false on ext4, true on NTFS and
  // APFS — so no single setting agrees with git everywhere. Folding drops a file git keeps
  // wherever git is case-sensitive, which is the failure this mechanism exists to stop; the
  // matcher's own default folds, and is turned off. Measured against git on ext4.
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
    // One file, two runs, rather than two files: NTFS and APFS would fold the second name
    // into the first and leave nothing to tell apart.
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
    // `**/dist/**` is category A of the drop list, not a gitignore rule, and it is not up for
    // negotiation by the workspace's `.gitignore`.
    await writeFileAt("src/a.ts")
    await writeFileAt("dist/bundle.ts")
    await writeGitignore("!dist/bundle.ts")

    expect(await discover()).toEqual(["src/a.ts"])
  })

  it("changes nothing when respectGitignore is false", async () => {
    await writeFileAt("src/a.ts")
    await writeFileAt("gen/keep.ts")
    await writeGitignore("gen/", "!gen/keep.ts")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["gen/keep.ts", "src/a.ts"])
  })

  it("reads a .gitignore below the workspace root", async () => {
    // This line used to assert the opposite, and said why: "the day the nested ones are read
    // this line is what says so". Precedence between two files that disagree is the subject of
    // `gitignore-nested.test.ts`; here it is only that a deeper one is read at all.
    await writeFileAt("src/a.ts")
    await writeFileAt("src/nested/x.ts")
    await writeFile(join(workRoot, "src/nested/.gitignore"), "x.ts\n", "utf8")
    await writeGitignore("# the root file excludes nothing")

    expect(await discover()).toEqual(["src/a.ts"])
  })
})

describe("discoverFiles — the lines a .gitignore is allowed to contain", () => {
  it("skips comments and blank lines, keeps CRLF and trailing spaces straight", async () => {
    // Five line shapes at once, because one parser handles them all and a fixture per shape
    // would not prove they compose. The escaped `#` is a filename, not a comment.
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
    // Rules used to compile on the first question asked rather than when the file is read, so
    // an unusable line threw at some later candidate as a bare SyntaxError naming neither the
    // `.gitignore` nor the workspace. Refused by length here, before any engine sees it.
    await writeFileAt("src/a.ts")
    await writeGitignore("a".repeat(5_000))

    const thrown = await discoverOrThrow()

    expect((thrown as { code?: string }).code).toBe("scan-gitignore-unreadable")
    expect((thrown as Error).message).toContain(".gitignore")
  })

  it("takes a rule of exactly the maximum length, and refuses one character more", async () => {
    // The limit is pinned from both sides or it is not pinned at all: every other fixture here
    // is far past it, so a limit lowered to sixty would pass them all while refusing ordinary
    // path globs. The honoured side is also what "rules out no real pattern" rests on.
    await writeFileAt("src/a.ts")
    await writeGitignore("a".repeat(4_096))

    expect(await discover()).toEqual(["src/a.ts"])

    await writeGitignore("a".repeat(4_097))
    const thrown = await discoverOrThrow()

    expect((thrown as { code?: string }).code).toBe("scan-gitignore-unreadable")
  })

  it("names the file when a rule inside the limit is one the engine refuses", async () => {
    // The length gate is not the whole guard. `ignore` splits a pattern on `/` and builds the
    // regex around the pieces, so a `[` with a `/` inside it is an unterminated character class
    // at any length — five characters here. Without the per-line compilation this reaches a
    // candidate as a bare SyntaxError, which is the failure the length gate cannot catch.
    await writeFileAt("src/a.ts")
    await writeGitignore("a/[/b")

    const thrown = await discoverOrThrow()

    expect((thrown as { code?: string }).code).toBe("scan-gitignore-unreadable")
    expect((thrown as Error).message).toContain("line 1")
  })
})

// Two spellings of one name need a filesystem that keeps both; APFS resolves them to a single
// file, so the collision fixture cannot exist there.
const onCollidingFs = it.skipIf(process.platform === "darwin")

describe("discoverFiles — which spelling the matcher is asked about, and when", () => {
  it("matches the spelling on disk, not the one the Document would record", async () => {
    // A path enters the Document in NFC. Git matches the bytes the filesystem stored, so a
    // `.gitignore` naming the decomposed spelling has to exclude the decomposed file — asked
    // about the normalized one, the matcher would keep it.
    await writeFileAt(DECOMPOSED)
    await writeFileAt("src/a.ts")
    await writeGitignore(DECOMPOSED)

    expect(await discover()).toEqual(["src/a.ts"])
  })

  it("excludes a file before the path it could never take is decided", async () => {
    // `v#1` holds a Symbol id separator, so a candidate under it is recorded `unroutable` and
    // named in `stats.skippedFiles`. A `.gitignore`d file is not a candidate at all: asked
    // about after that arm, it would be reported as a loss the workspace itself excluded.
    await writeFileAt("src/v#1/emitted.ts")
    await writeFileAt("src/a.ts")
    await writeGitignore("src/v#1/")

    const result = await discoverFiles({ workspaceRoot: workRoot, languageExtensions: [".ts"] })

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts"])
    expect(result.skipped).toEqual([])
  })

  it("excludes a file before its size is looked at", async () => {
    // The same rule one arm further down: an excluded file over the size cap would otherwise
    // be reported `over-size`, sending the reader to raise a budget for a file the workspace
    // does not want read.
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
    // Two names that normalize to one Document path are withdrawn as a group. Excluding one of
    // them leaves a single claimant, which is an ordinary file — so the matcher has to be
    // asked before the claim is recorded, or the workspace's own exclusion would still cost
    // the other file.
    await writeFileAt(DECOMPOSED)
    await writeFileAt(COMPOSED)
    await writeGitignore(DECOMPOSED)

    const result = await discoverFiles({ workspaceRoot: workRoot, languageExtensions: [".ts"] })

    expect(result.files.map((f) => f.path)).toEqual([COMPOSED])
    expect(result.unrepresentableFiles).toEqual([])
  })
})
