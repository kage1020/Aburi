import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import ignore, { type Ignore } from "ignore"
import { glob } from "tinyglobby"
import { CoreError } from "../errors"
import { describeThrown, errorCode } from "./faults"

/** The one filename git reads per directory. */
const GITIGNORE_FILENAME = ".gitignore"

/**
 * The repository's own metadata. Git does not read `.git/.gitignore` — measured — and the walk
 * below would, since a dotted directory is an ordinary directory to it. Written out rather than
 * left to `dot: false`, which would also skip a `.config/.gitignore` that git does read.
 */
const GIT_DIRECTORY_GLOB = "**/.git/**"

/** What a directory's rules say about one candidate. Both matchers can be silent. */
const VERDICT = { none: 0, ignored: 1, kept: 2 } as const
type Verdict = (typeof VERDICT)[keyof typeof VERDICT]

/**
 * Every `.gitignore` in the workspace, answering the one question discovery asks.
 *
 * Git consults a `.gitignore` in every directory from the repository root down to the file's
 * own, and a deeper file's rules override a shallower one's — so `packages/app/.gitignore`
 * saying `fixtures/` is the ordinary way to declare that a package's fixtures are not source.
 * A single merged rule list cannot express that: precedence is per directory, and two files
 * that disagree about one path are decided by which one is deeper, not by which line came last.
 *
 * What is deliberately *not* read is `$GIT_DIR/info/exclude` and `core.excludesFile`. Both live
 * outside the tree and are per-machine, so honouring them would make the Document depend on who
 * ran the scan — the property `ir-schema.md §1` exists to defend. A `.gitignore` is committed,
 * so every clone of the workspace answers the same.
 */
export interface GitignoreSet {
  /**
   * Whether git would ignore this file. The path is workspace-relative POSIX in the spelling
   * the filesystem gave it, which is what git matches against and what keys the matchers.
   */
  ignores(path: string): boolean
}

/**
 * Read every `.gitignore` the walk can reach and build the matcher discovery asks per candidate.
 *
 * `dropGlobs` are the discovery walk's own exclusions, applied here too: a `.gitignore` inside
 * `node_modules` cannot change an answer, because every path it could speak about is already
 * gone. That also settles the ordering problem the naive reading has — git learns about a
 * nested file only by descending into its directory, and never descends into an ignored one, so
 * a file inside a git-ignored directory would be read here and not by git. It is read, and it
 * decides nothing: every candidate it could match sits under a directory this matcher has
 * already ruled out, and the walk below stops at the first excluded prefix.
 *
 * `null` rather than an empty set when the workspace holds no `.gitignore` at all: an instance
 * with no rules still walks the directory chain of every candidate, and the off switch should
 * not pay for a question that cannot have an answer.
 */
export async function readGitignores(
  workspaceRoot: string,
  dropGlobs: readonly string[],
): Promise<GitignoreSet | null> {
  const root = resolve(workspaceRoot)
  const found = await glob([`**/${GITIGNORE_FILENAME}`], {
    cwd: root,
    ignore: [...dropGlobs, GIT_DIRECTORY_GLOB],
    onlyFiles: true,
    dot: true,
    absolute: false,
  })

  const matchers = new Map<string, Ignore>()
  for (const relative of found) {
    const directory = relative.slice(
      0,
      Math.max(0, relative.length - GITIGNORE_FILENAME.length - 1),
    )
    const matcher = await readMatcher(resolve(root, relative))
    if (matcher !== null) matchers.set(directory, matcher)
  }
  if (matchers.size === 0) return null
  return new DirectoryChain(matchers)
}

/**
 * One directory's rules, or `null` when the file is not there.
 *
 * ENOENT covers both a file the glob never saw and one that vanished between the listing and
 * this read; either way the directory has nothing to say. Every other failure — permission
 * denied, an IO error, a line no regex engine will take — stops the scan, because a rule list
 * that silently came up empty would hand the IR files the workspace had excluded.
 */
async function readMatcher(path: string): Promise<Ignore | null> {
  try {
    const content = await readFile(path, "utf8")
    const matcher = ignore({ ignorecase: false }).add(content)
    // `add` stores the lines; the regexes are built on the first question asked. A line long
    // enough to blow the regex engine therefore throws at the first candidate, far from here,
    // as a bare SyntaxError naming no file at all. One throwaway question compiles every rule
    // while the catch below can still say which `.gitignore` it was.
    matcher.ignores("a")
    return matcher
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw new CoreError(
      `.gitignore at "${path}" could not be used: ${describeThrown(error)}`,
      { code: "scan-gitignore-unreadable", value: path },
      { cause: error },
    )
  }
}

/**
 * Git's precedence, expressed as a walk down the candidate's directory chain.
 *
 * Each prefix is decided as a directory before the file is decided at all, and the first
 * excluded one ends the question — that is git's "it is not possible to re-include a file if a
 * parent directory of that file is excluded", which falls out of git never descending. The
 * distinction it turns on is real and measured: `generated/` excludes the directory and a
 * nested `!g.ts` rescues nothing, while `generated/*` excludes only the contents, so the same
 * nested rule is reached and works.
 *
 * At each step the answer is the deepest directory with an opinion. `Ignore.test` reports
 * `{ ignored, unignored }` and both false is what silence looks like; `ignores()` cannot say
 * it, which is why the three-state call is the one used here.
 */
class DirectoryChain implements GitignoreSet {
  /** Keyed by workspace-relative directory, `""` for the root. */
  readonly #matchers: Map<string, Ignore>
  /** Whether a directory is excluded, itself or by an ancestor. Directories repeat; files do not. */
  readonly #directories = new Map<string, boolean>()

  constructor(matchers: Map<string, Ignore>) {
    this.#matchers = matchers
  }

  ignores(path: string): boolean {
    const lastSlash = path.lastIndexOf("/")
    if (lastSlash >= 0 && this.#directoryExcluded(path.slice(0, lastSlash))) return true
    return this.#decide(path) === VERDICT.ignored
  }

  /** A directory is out if any directory on the way to it was, or if its own chain says so. */
  #directoryExcluded(directory: string): boolean {
    const cached = this.#directories.get(directory)
    if (cached !== undefined) return cached
    const lastSlash = directory.lastIndexOf("/")
    const inherited = lastSlash >= 0 && this.#directoryExcluded(directory.slice(0, lastSlash))
    // The trailing slash is what tells a `dist/` rule it is looking at a directory: without it
    // the rule has no opinion on the bare name, and the subtree would survive its own exclusion.
    const excluded = inherited || this.#decide(`${directory}/`) === VERDICT.ignored
    this.#directories.set(directory, excluded)
    return excluded
  }

  /**
   * The verdict of the deepest `.gitignore` above `candidate` that has one.
   *
   * Strictly above: a directory's own file is not consulted about the directory, which is what
   * keeps `pkg/.gitignore` from re-including `pkg` after the root excluded it — and is again
   * just git not descending. For a file candidate, its own directory is above it and does count.
   */
  #decide(candidate: string): Verdict {
    let verdict: Verdict = VERDICT.none
    let boundary = -1
    for (;;) {
      const directory = boundary < 0 ? "" : candidate.slice(0, boundary)
      const matcher = this.#matchers.get(directory)
      if (matcher !== undefined) {
        const relative = boundary < 0 ? candidate : candidate.slice(boundary + 1)
        const { ignored, unignored } = matcher.test(relative)
        if (ignored) verdict = VERDICT.ignored
        else if (unignored) verdict = VERDICT.kept
      }
      const next = candidate.indexOf("/", boundary + 1)
      // The last segment is the candidate itself, whose own directory — if it is one — must not
      // be asked about it.
      if (next < 0 || next === candidate.length - 1) return verdict
      boundary = next
    }
  }
}
