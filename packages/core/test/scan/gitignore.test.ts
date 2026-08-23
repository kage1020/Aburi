import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

async function writeFileAt(rel: string, content = "1"): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(abs.slice(0, Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"))), {
    recursive: true,
  })
  await writeFile(abs, content, "utf8")
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
    expect(await discover()).toContain("assets/keep.ts")
    expect(await discover()).not.toContain("assets/drop.ts")
  })

  it("re-includes nothing under a directory that was excluded outright", async () => {
    // `gen/` excludes the directory itself. Git does not descend, so `!gen/keep.ts` has
    // nothing to act on — the one case the old translation got right, and the case the issue
    // reported as broken.
    expect(await discover()).not.toContain("gen/keep.ts")
    expect(await discover()).not.toContain("gen/other.ts")
  })

  it("lets a negated directory put its whole subtree back", async () => {
    expect(await discover()).toEqual(expect.arrayContaining(["src/a.ts", "src/keepme/c.ts"]))
  })

  it("reads brackets as a character class, so a literal one is not matched", async () => {
    // `a[1].ts` matches `a1.ts`. The file actually named `a[1].ts` is not ignored, and used
    // to be.
    expect(await discover()).toContain("a[1].ts")
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

describe("discoverFiles — what a .gitignore negation cannot reach", () => {
  it("cannot rescue a file config.ignore excluded", async () => {
    await writeFileAt("src/a.ts")
    await writeFileAt("src/local.ts")
    await writeFile(join(workRoot, ".gitignore"), "!src/local.ts\n", "utf8")

    expect(await discover({ ignore: ["src/local.ts"] })).toEqual(["src/a.ts"])
  })

  it("cannot rescue a file a core drop pattern excluded", async () => {
    // `**/dist/**` is category A of the drop list, not a gitignore rule, and it is not up for
    // negotiation by the workspace's `.gitignore`.
    await writeFileAt("src/a.ts")
    await writeFileAt("dist/bundle.ts")
    await writeFile(join(workRoot, ".gitignore"), "!dist/bundle.ts\n", "utf8")

    expect(await discover()).toEqual(["src/a.ts"])
  })

  it("changes nothing when respectGitignore is false", async () => {
    await writeFileAt("src/a.ts")
    await writeFileAt("gen/keep.ts")
    await writeFile(join(workRoot, ".gitignore"), "gen/\n!gen/keep.ts\n", "utf8")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["gen/keep.ts", "src/a.ts"])
  })
})

describe("discoverFiles — the lines a .gitignore is allowed to contain", () => {
  it("skips comments and blank lines, keeps CRLF and trailing spaces straight", async () => {
    // Five line shapes at once, because they are handled by one parser and a fixture per
    // shape would not prove they compose.
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
    await writeFile(join(workRoot, ".gitignore"), "# nothing here\n\n", "utf8")

    expect(await discover()).toEqual(["src/a.ts"])
  })
})
