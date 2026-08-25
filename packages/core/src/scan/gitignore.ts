import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import ignore, { type Ignore } from "ignore"
import { CoreError } from "../errors"
import { describeThrown, isVanishedFile } from "./faults"

/** The one filename git reads per directory. */
const GITIGNORE_FILENAME = ".gitignore"

/**
 * The longest rule this will hand to the regex engine.
 *
 * Not a style rule — a determinism one. Where a regex engine's code-size limit falls, and what
 * reaching it costs, is the engine's business: the same rule is accepted at 32,000 characters
 * and refused at 33,000 on one platform, and takes the better part of a minute to refuse on
 * another. A workspace whose `.gitignore` holds such a line would scan on one machine and fail
 * on the next, which is the property this Document is built to avoid — and the run that failed
 * would have paid for the privilege. The measurements are in the changeset that introduced this.
 *
 * Refusing outright at a fixed length settles it, costs nothing, and rules out no real pattern:
 * a gitignore rule is a path glob, and 4096 is `PATH_MAX` on the platform that allows the
 * longest one.
 */
const MAX_RULE_LENGTH = 4096

/** How much of a rule the failure message quotes. A pattern can be longer than a screen. */
const QUOTED_RULE_LENGTH = 60

/** How much of the engine's own diagnostic survives, from each end. */
const QUOTED_REASON_HEAD = 40
const QUOTED_REASON_TAIL = 60

/** What one directory's rules say about one candidate. Silence is an answer the walk needs. */
type Verdict = "none" | "ignored" | "kept"

/**
 * The `.gitignore` files of a workspace, answering the one question discovery asks.
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
export interface GitignoreTree {
  /**
   * Whether git would ignore this file.
   *
   * The path is workspace-relative POSIX, non-empty, with no leading `./` or `../` and no drive
   * or root — `ignore` throws a bare `TypeError` / `RangeError` on each of those, carrying no
   * code and no hint that a `.gitignore` was involved. It is the spelling the filesystem gave,
   * not the Document's: git matches what is on disk, and the directory keys come from the same
   * place, so a decomposed directory name still matches its own rule file.
   *
   * Asynchronous because the rule files are opened as the walk reaches them, which is how git
   * finds them too — a `.gitignore` under a directory that turned out to be excluded is never
   * opened at all. Each directory is read at most once and the answer is cached, so a
   * `.gitignore` created part-way through a scan may or may not be seen.
   */
  ignores(path: string): Promise<boolean>
}

/**
 * A view of the workspace's `.gitignore` files. Nothing is read until a candidate needs it.
 *
 * Reading on descent rather than listing the files up front is not an optimisation — it is the
 * rule. Git learns of a nested `.gitignore` only by walking into its directory, and it does not
 * walk into an excluded one, so a rule file under an excluded directory is not merely inert but
 * unseen. Listing them first made the difference visible in the one way an inert file still
 * speaks: a `.gitignore` that cannot be *used* ends the run, and one under `node_modules`,
 * under a git-ignored directory, or in `.git` itself would have ended a run git would not even
 * have opened it during.
 */
export function openGitignoreTree(workspaceRoot: string): GitignoreTree {
  return new GitignoreDescent(resolve(workspaceRoot))
}

/**
 * One directory's rules, or `null` when that directory has none to give.
 *
 * `null` covers every way the name fails to be a rule file, and each is git's own answer,
 * measured:
 *
 * - nothing there, or the parent stopped being a directory mid-scan (`ENOENT` / `ENOTDIR`, one
 *   act reported under two codes depending on the platform — see `isVanishedFile`)
 * - a **directory** named `.gitignore`: `git check-ignore` reports nothing for it
 * - a **symlink**: git refuses to follow one for `.gitignore`, resolvable or not, and warns
 * - anything else that is not a regular file: git blocks forever on a FIFO, which is not a
 *   behaviour worth reproducing
 *
 * Everything else — permission denied, an IO error, a line no regex engine will take — stops
 * the scan naming the file. That is stricter than git, which warns and carries on, and
 * deliberately: a rule list that silently came up empty hands the Document files the workspace
 * had excluded, and only on the machine where the read failed.
 */
async function readMatcher(path: string): Promise<Ignore | null> {
  let content: string
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) return null
    content = await readFile(path, "utf8")
  } catch (error) {
    if (isVanishedFile(error)) return null
    throw new CoreError(
      `.gitignore at "${path}" could not be read: ${describeThrown(error)}`,
      { code: "scan-gitignore-unreadable", value: path },
      { cause: error },
    )
  }
  assertEveryRuleCompiles(content, path)
  return ignore({ ignorecase: false }).add(content)
}

/**
 * Compile every rule now, one throwaway matcher per line, so a rule the regex engine refuses is
 * reported against the line that holds it.
 *
 * `add` only stores the lines; each rule's `RegExp` is built the first time a question reaches
 * it, and questions do not reach every rule. A negative rule is skipped while nothing has
 * matched yet, and a rule that matches shadows the same-polarity rules after it — so asking one
 * throwaway question of the assembled matcher leaves whole lines uncompiled, and they throw a
 * bare `SyntaxError` at some candidate hundreds of files later, naming neither the file nor the
 * line. One matcher per line has no such shadow: nothing precedes the rule under test.
 */
function assertEveryRuleCompiles(content: string, path: string): void {
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (isDiscardedLine(line)) continue
    // The string `ignore` will compile, which is the line minus the trailing whitespace it
    // strips. Measuring anything else leaves a way past this gate: `trim()` reduces a rule of
    // four thousand spaces and one character to one character, and the engine still receives
    // all four thousand and one.
    const rule = line.trimEnd()
    if (rule.length > MAX_RULE_LENGTH) {
      throw refuseRule(path, index, rule, `it is longer than ${MAX_RULE_LENGTH} characters`)
    }
    try {
      ignore({ ignorecase: false }).add(line).test("a")
    } catch (error) {
      throw refuseRule(path, index, rule, abbreviate(describeThrown(error)), error)
    }
  }
}

/**
 * The lines `ignore` itself throws away before compiling anything, and only those.
 *
 * Its own predicate, deliberately. A line is a comment when the `#` is the **first character**,
 * so `  #foo` is a live pattern to it — skipping that here would hand the engine a rule this
 * function had just promised to have checked, and it is a rule the engine can refuse.
 */
function isDiscardedLine(line: string): boolean {
  return /^\s*$/.test(line) || line.startsWith("#")
}

/** Both ends of a long diagnostic: the kind of failure is at the front, the reason at the back. */
function abbreviate(reason: string): string {
  if (reason.length <= QUOTED_REASON_HEAD + QUOTED_REASON_TAIL) return reason
  return `${reason.slice(0, QUOTED_REASON_HEAD)}…${reason.slice(-QUOTED_REASON_TAIL)}`
}

/**
 * The one shape both refusals take: which file, which line, an abridged quotation of the rule,
 * and why.
 *
 * Both halves are abridged, because a `CoreError` is not a `CliError` and the CLI prints its
 * message verbatim. Neither is bounded on its own: a rule may run to the length limit, and the
 * engine's own diagnostic quotes the whole pattern it refused — four kilobytes of it for a rule
 * that stops just short of that limit.
 */
function refuseRule(
  path: string,
  index: number,
  rule: string,
  reason: string,
  cause?: unknown,
): CoreError {
  const quoted = rule.length > QUOTED_RULE_LENGTH ? `${rule.slice(0, QUOTED_RULE_LENGTH)}…` : rule
  return new CoreError(
    `.gitignore at "${path}" line ${index + 1} is not a usable pattern ("${quoted}", ` +
      `${rule.length} characters): ${reason}`,
    { code: "scan-gitignore-unreadable", value: path },
    cause === undefined ? {} : { cause },
  )
}

/**
 * Git's precedence, expressed as a descent down the candidate's directory chain.
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
class GitignoreDescent implements GitignoreTree {
  readonly #workspaceRoot: string
  /** Directory → its rules, `null` for none. A cache: absent means "not reached yet". */
  readonly #matchers = new Map<string, Ignore | null>()
  /** Directory → excluded, itself or by an ancestor. Directories repeat; files do not. */
  readonly #excluded = new Map<string, boolean>()

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot
  }

  async ignores(path: string): Promise<boolean> {
    const lastSlash = path.lastIndexOf("/")
    if (lastSlash >= 0 && (await this.#directoryExcluded(path.slice(0, lastSlash)))) return true
    return (await this.#decide(path, "file")) === "ignored"
  }

  /**
   * A directory is out if any directory on the way to it was, or if its own chain says so.
   *
   * The inherited half is what stops two nested files rescuing a subtree one directory at a
   * time: `gen/.gitignore` can un-exclude `sub/`, and `gen/sub/.gitignore` can un-ignore a file
   * in it, and git ignores the file anyway because it never reached `gen`.
   */
  async #directoryExcluded(directory: string): Promise<boolean> {
    const cached = this.#excluded.get(directory)
    if (cached !== undefined) return cached
    const lastSlash = directory.lastIndexOf("/")
    const inherited =
      lastSlash >= 0 && (await this.#directoryExcluded(directory.slice(0, lastSlash)))
    const excluded = inherited || (await this.#decide(directory, "directory")) === "ignored"
    this.#excluded.set(directory, excluded)
    return excluded
  }

  /**
   * The verdict of the deepest `.gitignore` above `candidate` that has one.
   *
   * Strictly above: a directory's own file is not consulted about the directory, which is what
   * keeps `pkg/.gitignore` from re-including `pkg` after the root excluded it — and is again
   * just git not descending. For a file candidate, its own directory is above it and does count.
   *
   * A directory is asked about with a trailing `/`, which is git's and `ignore`'s own boundary
   * convention: without it a `dist/` rule has no opinion on the bare name `dist`, and a subtree
   * would survive its own exclusion.
   */
  async #decide(candidate: string, kind: "file" | "directory"): Promise<Verdict> {
    const subject = kind === "directory" ? `${candidate}/` : candidate
    let verdict: Verdict = "none"
    let boundary = -1
    for (;;) {
      const directory = boundary < 0 ? "" : subject.slice(0, boundary)
      const matcher = await this.#matcherFor(directory)
      if (matcher !== null) {
        const relative = boundary < 0 ? subject : subject.slice(boundary + 1)
        const { ignored, unignored } = matcher.test(relative)
        if (ignored) verdict = "ignored"
        else if (unignored) verdict = "kept"
      }
      const next = subject.indexOf("/", boundary + 1)
      // The last segment is the candidate itself. A trailing `/` makes it the empty segment,
      // which is the directory's own file — the one that must not judge its own directory.
      if (next < 0 || next === subject.length - 1) return verdict
      boundary = next
    }
  }

  /** Read at most once per directory, and only when the descent actually reached it. */
  async #matcherFor(directory: string): Promise<Ignore | null> {
    const cached = this.#matchers.get(directory)
    if (cached !== undefined) return cached
    const matcher = await readMatcher(resolve(this.#workspaceRoot, directory, GITIGNORE_FILENAME))
    this.#matchers.set(directory, matcher)
    return matcher
  }
}
