import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverFiles } from "../../src"

/**
 * Git reads a `.gitignore` in every directory from the repository root down to the file's own,
 * and a deeper file's rules override a shallower one's. Discovery read exactly one, so
 * `packages/app/.gitignore` holding `fixtures/` did nothing and those files reached the IR.
 *
 * Every verdict below was taken from `git check-ignore` on the same layout, on ext4 so nothing
 * is decided by case folding. They are hardcoded rather than compared against a subprocess:
 * a test that shells out proves the two agree on whatever git is installed and says nothing
 * about what either does, where these say what the answer is — and a change to one of them has
 * to change a line here.
 *
 * Not read, and not by accident: `$GIT_DIR/info/exclude` and `core.excludesFile`. Both are
 * per-machine, so honouring them would make the Document depend on who ran the scan.
 */

let workRoot: string

async function writeFileAt(rel: string, content = "1"): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

/** A `.gitignore` in `directory` (`""` for the workspace root). */
async function gitignoreIn(directory: string, ...lines: readonly string[]): Promise<void> {
  await writeFileAt(join(directory, ".gitignore"), `${lines.join("\n")}\n`)
}

async function discover(options: { respectGitignore?: boolean } = {}): Promise<string[]> {
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
  workRoot = await mkdtemp(join(tmpdir(), "aburi-gitignore-nested-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

describe("a .gitignore in every directory", () => {
  it("honours a package's own file, and only under that package", async () => {
    await gitignoreIn("pkg", "fixtures/")
    await writeFileAt("pkg/fixtures/a.ts")
    await writeFileAt("other/fixtures/a.ts")

    expect(await discover()).toEqual(["other/fixtures/a.ts"])
  })

  it("anchors a nested pattern to the directory that declared it", async () => {
    // `/local.ts` is anchored, and what it is anchored to is `pkg` — not the workspace root,
    // and not every directory under `pkg`.
    await gitignoreIn("pkg", "/local.ts")
    await writeFileAt("pkg/local.ts")
    await writeFileAt("pkg/sub/local.ts")
    await writeFileAt("local.ts")

    expect(await discover()).toEqual(["local.ts", "pkg/sub/local.ts"])
  })

  it("reads a file two directories down", async () => {
    await gitignoreIn("a/b", "fixtures/")
    await writeFileAt("a/b/fixtures/x.ts")
    await writeFileAt("a/fixtures/x.ts")

    expect(await discover()).toEqual(["a/fixtures/x.ts"])
  })

  it("lets a deeper negation put a file back", async () => {
    await gitignoreIn("", "*.ts")
    await gitignoreIn("pkg", "!keep.ts")
    await writeFileAt("pkg/keep.ts")
    await writeFileAt("pkg/other.ts")

    expect(await discover()).toEqual(["pkg/keep.ts"])
  })

  it("lets a deeper exclusion take one away", async () => {
    // The other direction, and the one a "nested files only ever re-include" reading gets
    // wrong: precedence is by depth, not by which way the rule points.
    await gitignoreIn("", "!*.ts")
    await gitignoreIn("pkg", "keep.ts")
    await writeFileAt("pkg/keep.ts")
    await writeFileAt("pkg/other.ts")

    expect(await discover()).toEqual(["pkg/other.ts"])
  })

  it("takes the deepest opinion when three files disagree", async () => {
    // Two files cannot tell "the deepest decides" apart from "the nested one decides".
    await gitignoreIn("", "*.ts")
    await gitignoreIn("pkg", "!keep.ts")
    await gitignoreIn("pkg/sub", "keep.ts")
    await writeFileAt("pkg/keep.ts")
    await writeFileAt("pkg/sub/keep.ts")

    expect(await discover()).toEqual(["pkg/keep.ts"])
  })

  it("re-includes nothing under a directory the root excluded outright", async () => {
    // Git never descends into `generated/`, so the file is not there to be rescued. A matcher
    // that only ever asked about the full path would hand this one back.
    await gitignoreIn("", "generated/")
    await gitignoreIn("generated", "!g.ts")
    await writeFileAt("generated/g.ts")

    expect(await discover()).toEqual([])
  })

  it("re-includes under a directory whose contents, not the directory, were excluded", async () => {
    // `generated/*` leaves the directory itself un-excluded, so git walks in and the nested
    // negation is reached. The pair with the case above is what pins the distinction.
    await gitignoreIn("", "generated/*")
    await gitignoreIn("generated", "!g.ts")
    await writeFileAt("generated/g.ts")
    await writeFileAt("generated/x.ts")

    expect(await discover()).toEqual(["generated/g.ts"])
  })

  it("does not let two nested files together rescue a file under an excluded directory", async () => {
    // The shape that needs the exclusion to be *inherited* rather than re-derived. `gen/` puts
    // the whole subtree out; `gen/.gitignore` un-excludes `sub/`, so asked in isolation that
    // directory looks fine again; and `gen/sub/.gitignore` then un-ignores the file. Git
    // ignores it regardless — it never descended into `gen`, so neither of those files exists
    // as far as it is concerned. Rescuing one directory at a time is still not rescuing.
    await gitignoreIn("", "gen/")
    await gitignoreIn("gen", "!sub/")
    await gitignoreIn("gen/sub", "!x.ts")
    await writeFileAt("gen/sub/x.ts")
    await writeFileAt("gen/sub/y.ts")
    await writeFileAt("keep.ts")

    expect(await discover()).toEqual(["keep.ts"])
  })

  it("does not let a directory's own file re-include the directory", async () => {
    await gitignoreIn("", "pkg/")
    await gitignoreIn("pkg", "!keep.ts")
    await writeFileAt("pkg/keep.ts")

    expect(await discover()).toEqual([])
  })

  it("governs a directory whose name is decomposed", async () => {
    // The matcher is keyed by the spelling the filesystem gave, and the candidate arrives in
    // the same spelling — normalising either one would stop the directory matching its own file.
    const directory = "café".normalize("NFD")
    await gitignoreIn(directory, "drop.ts")
    await writeFileAt(`${directory}/drop.ts`)
    await writeFileAt(`${directory}/keep.ts`)

    expect(await discover()).toEqual([`${"café".normalize("NFC")}/keep.ts`])
  })
})

describe("what is not read", () => {
  it("never opens a .gitignore inside .git", async () => {
    // Not a rule file to git, whatever it holds. Its *rules* could not reach outside `.git`
    // anyway — a matcher only speaks about its own subtree, and nothing under `.git` is a
    // candidate — so what says the file was skipped is that a line no regex engine will take
    // did not end the run.
    await writeFileAt(join(".git", ".gitignore"), `${"a".repeat(40_000)}\n`)
    await writeFileAt("keep.ts")

    expect(await discover()).toEqual(["keep.ts"])
  })

  it("never opens a .gitignore under a directory the drop globs already removed", async () => {
    // Same reasoning, same evidence: a `node_modules` package's own file cannot change a
    // verdict about anything that survived the walk, and a scan must not fail over one.
    await writeFileAt(join("node_modules", "pkg", ".gitignore"), `${"a".repeat(40_000)}\n`)
    await writeFileAt("keep.ts")

    expect(await discover()).toEqual(["keep.ts"])
  })

  it("reads nothing at any depth when respectGitignore is off", async () => {
    await gitignoreIn("", "root.ts")
    await gitignoreIn("pkg", "nested.ts")
    await writeFileAt("root.ts")
    await writeFileAt("pkg/nested.ts")

    expect(await discover({ respectGitignore: false })).toEqual(["pkg/nested.ts", "root.ts"])
  })
})

describe("a nested file that cannot be used", () => {
  it("fails naming the nested file, not the root one", async () => {
    await gitignoreIn("", "root.ts")
    await writeFileAt("pkg/a.ts")
    // A single pattern longer than the regex engine will compile. The failure is raised while
    // the file is still identifiable, rather than 200 candidates later as a bare SyntaxError.
    await writeFileAt(join("pkg", ".gitignore"), `${"a".repeat(40_000)}\n`)

    const thrown = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect((thrown as Error).message).toContain(join(workRoot, "pkg", ".gitignore"))
    expect((thrown as Error).message).not.toContain(join(workRoot, ".gitignore"))
  })
})
