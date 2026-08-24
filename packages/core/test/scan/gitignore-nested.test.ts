import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
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

/**
 * A pattern past the length the matcher hands to a regex engine at all.
 *
 * Not an engine failure: where the engine's own size limit falls is the engine's business, and
 * measured, V8 refuses somewhere above 32,000 characters on one platform and spends forty
 * seconds reaching the same verdict on another. The matcher refuses at a fixed length before
 * any of that, which is what makes this fixture instant and identical everywhere.
 */
const UNUSABLE = "a".repeat(5_000)

async function writeFileAt(rel: string, content = "1"): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

async function symlinkAt(target: string, rel: string): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await symlink(target, abs)
}

/** A `.gitignore` in `directory` (`""` for the workspace root). */
async function gitignoreIn(directory: string, ...lines: readonly string[]): Promise<void> {
  await writeFileAt(join(directory, ".gitignore"), `${lines.join("\n")}\n`)
}

async function discoverWith(
  options: { respectGitignore?: boolean; ignore?: readonly string[] } = {},
): Promise<string[]> {
  const result = await discoverFiles({
    workspaceRoot: workRoot,
    languageExtensions: [".ts"],
    ...options,
  })
  expect(result.skipped).toEqual([])
  expect(result.unrepresentableFiles).toEqual([])
  return result.files.map((f) => f.path)
}

const discover = discoverWith

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
    // candidate — so what says the file was skipped is that a line the matcher refuses did not
    // end the run.
    await writeFileAt(join(".git", ".gitignore"), `${UNUSABLE}\n`)
    await writeFileAt("keep.ts")

    expect(await discover()).toEqual(["keep.ts"])
  })

  it("never opens a .gitignore under a directory the drop globs already removed", async () => {
    // Same reasoning, same evidence: a `node_modules` package's own file cannot change a
    // verdict about anything that survived the walk, and a scan must not fail over one.
    await writeFileAt(join("node_modules", "pkg", ".gitignore"), `${UNUSABLE}\n`)
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
  async function discoverOrThrow(): Promise<unknown> {
    return await discoverFiles({ workspaceRoot: workRoot, languageExtensions: [".ts"] }).then(
      () => null,
      (error: unknown) => error,
    )
  }

  it("fails naming the nested file, not the root one", async () => {
    await gitignoreIn("", "root.ts")
    await writeFileAt("pkg/a.ts")
    await writeFileAt(join("pkg", ".gitignore"), `${UNUSABLE}\n`)

    const thrown = await discoverOrThrow()

    expect((thrown as Error).message).toContain(join(workRoot, "pkg", ".gitignore"))
    expect((thrown as Error).message).not.toContain(join(workRoot, ".gitignore"))
  })

  it("names a rule the walk would never have asked about", async () => {
    // A negative rule is skipped while nothing has matched, and a rule that matches shadows the
    // same-polarity rules after it — so one throwaway question of the assembled matcher reaches
    // neither of these. Every line is looked at now, whichever position and polarity it holds.
    for (const [directory, rules] of [
      ["negation", [`!${UNUSABLE}`]],
      ["shadowed", ["a*", UNUSABLE]],
    ] as const) {
      await writeFileAt(`${directory}/a.ts`)
      await writeFileAt(join(directory, ".gitignore"), `${rules.join("\n")}\n`)

      const thrown = await discoverOrThrow()

      expect((thrown as { code?: string }).code).toBe("scan-gitignore-unreadable")
      expect((thrown as Error).message).toContain(join(workRoot, directory, ".gitignore"))
      await rm(join(workRoot, directory), { recursive: true, force: true })
    }
  })

  it("names the line, and quotes only the head of the rule", async () => {
    // `CoreError` is not a `CliError`, so the message reaches a terminal verbatim. Quoting the
    // rule whole would put five thousand characters of it there.
    await writeFileAt("pkg/a.ts")
    await writeFileAt(join("pkg", ".gitignore"), ["# a comment", "", "*.log", UNUSABLE].join("\n"))

    const thrown = await discoverOrThrow()

    expect((thrown as Error).message).toContain("line 4")
    expect((thrown as Error).message).toContain("5000 characters")
    expect((thrown as Error).message.length).toBeLessThan(1_000)
  })

  it("is not read at all when respectGitignore is off", async () => {
    // The off switch skips the read, not just the application. Nothing else here would notice
    // the difference: a matcher built and thrown away answers the same as no matcher.
    await gitignoreIn("", "root.ts")
    await writeFileAt(join("pkg", ".gitignore"), `${UNUSABLE}\n`)
    await writeFileAt("pkg/a.ts")
    await writeFileAt("root.ts")

    expect(await discover({ respectGitignore: false })).toEqual(["pkg/a.ts", "root.ts"])
  })

  it("is not read under a directory the caller's own ignore globs removed", async () => {
    // No candidate comes from there, so the descent never arrives. Reading it would let
    // `config.ignore` turn a workspace's own exclusions into a failed scan — or, if the read
    // succeeded, into no exclusions at all.
    await writeFileAt(join("private", ".gitignore"), `${UNUSABLE}\n`)
    await writeFileAt("private/a.ts")
    await writeFileAt("keep.ts")

    expect(await discoverWith({ ignore: ["private/**"] })).toEqual(["keep.ts"])
  })
})

// Creating a symlink on Windows needs a privilege an ordinary test run does not have.
const onPosix = it.skipIf(process.platform === "win32")

describe("a .gitignore that is not a regular file", () => {
  onPosix("does not follow a symlink, resolvable or not", async () => {
    // Measured: `git check-ignore` honours neither. It refuses to follow a symlinked
    // `.gitignore` at all — a resolvable one is read as nothing, and a dangling one warns.
    // Discovery agreed with the second by accident and the first not at all, because the walk
    // that listed the files resolved links and silently dropped the ones that would not.
    await writeFileAt("rules.txt", "drop.ts\n")
    await symlinkAt(join(workRoot, "rules.txt"), join("resolvable", ".gitignore"))
    await symlinkAt(join(workRoot, "nothing-here"), join("dangling", ".gitignore"))
    await writeFileAt("resolvable/drop.ts")
    await writeFileAt("dangling/drop.ts")

    expect(await discover()).toEqual(["dangling/drop.ts", "resolvable/drop.ts"])
  })
})
