import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CoreError } from "../errors"
import { describeThrown, isVanishedFile } from "./faults"
import { compileRules, type GitignoreRules, readRuleLines, type Verdict } from "./gitignore-pattern"

/** The one filename git reads per directory. */
const GITIGNORE_FILENAME = ".gitignore"

/**
 * The longest rule, in bytes, this will hand to the regex engine.
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

/** How much of a rule the failure message quotes, in bytes. A pattern can be longer than a screen. */
const QUOTED_RULE_LENGTH = 60

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
 * ran the scan — the property `ir-schema.md` exists to defend. A `.gitignore` is committed,
 * so every clone of the workspace answers the same.
 */
export interface GitignoreTree {
  /**
   * Whether git would ignore this file.
   *
   * The path is workspace-relative POSIX, non-empty, with no leading `./` or `../` and no drive
   * or root. That is the caller's contract, and what `glob({ absolute: false })` returns; nothing
   * here checks it. It is the spelling the filesystem gave, not the Document's: git matches what
   * is on disk, and the directory keys come from the same place, so a decomposed directory name
   * still matches its own rule file.
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
 * Everything else — permission denied, an IO error, a rule longer than `MAX_RULE_LENGTH` —
 * stops the scan naming the file. That is stricter than git, which warns and carries on, and
 * deliberately: a rule list that silently came up empty hands the Document files the workspace
 * had excluded, and only on the machine where the read failed.
 */
async function readMatcher(path: string): Promise<GitignoreRules | null> {
  let content: Buffer
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) return null
    content = await readFile(path)
  } catch (error) {
    if (isVanishedFile(error)) return null
    throw new CoreError(
      `.gitignore at "${path}" could not be read: ${describeThrown(error)}`,
      { code: "scan-gitignore-unreadable", value: path },
      { cause: error },
    )
  }
  const lines = readRuleLines(content)
  for (const line of lines) {
    if (line.bytes.length > MAX_RULE_LENGTH) {
      throw refuseRule(path, line.index, line.bytes, `it is longer than ${MAX_RULE_LENGTH} bytes`)
    }
  }
  return compileRules(lines)
}

/**
 * Which file, which line, an abridged quotation of the rule, and why. Abridged because a
 * `CoreError` is not a `CliError` and the CLI prints its message verbatim, and a rule may run to
 * the length limit. `rule` is the rule's bytes; the quotation is decoded back to text.
 */
function refuseRule(path: string, index: number, rule: string, reason: string): CoreError {
  const head = rule.length > QUOTED_RULE_LENGTH ? rule.slice(0, QUOTED_RULE_LENGTH) : rule
  const quoted = Buffer.from(head, "latin1").toString("utf8") + (head === rule ? "" : "…")
  return new CoreError(
    `.gitignore at "${path}" line ${index + 1} is not a usable pattern ("${quoted}", ` +
      `${rule.length} bytes): ${reason}`,
    { code: "scan-gitignore-unreadable", value: path },
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
 * At each step the answer is the deepest directory with an opinion, and each file is asked
 * about the candidate alone. Whether an ancestor directory was excluded is settled before, across
 * every file at once; a file that re-derived it from its own rules would answer for a directory
 * a deeper file had re-included, and its stale `ignored` would stand over the deeper file's
 * silence about the candidate.
 */
class GitignoreDescent implements GitignoreTree {
  readonly #workspaceRoot: string
  /** Directory → its rules, `null` for none. A cache: absent means "not reached yet". */
  readonly #matchers = new Map<string, GitignoreRules | null>()
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
   * A directory is asked about as one, so a `dist/` rule, which matches directories only, has
   * an opinion on it.
   */
  async #decide(candidate: string, kind: "file" | "directory"): Promise<Verdict> {
    const subject = kind === "directory" ? `${candidate}/` : candidate
    let verdict: Verdict = "none"
    let boundary = -1
    for (;;) {
      const directory = boundary < 0 ? "" : subject.slice(0, boundary)
      const matcher = await this.#matcherFor(directory)
      if (matcher !== null) {
        const relative = boundary < 0 ? candidate : candidate.slice(boundary + 1)
        const answer = matcher.decide(relative, kind === "directory")
        if (answer !== "none") verdict = answer
      }
      const next = subject.indexOf("/", boundary + 1)
      // The last segment is the candidate itself. A trailing `/` makes it the empty segment,
      // which is the directory's own file — the one that must not judge its own directory.
      if (next < 0 || next === subject.length - 1) return verdict
      boundary = next
    }
  }

  /** Read at most once per directory, and only when the descent actually reached it. */
  async #matcherFor(directory: string): Promise<GitignoreRules | null> {
    const cached = this.#matchers.get(directory)
    if (cached !== undefined) return cached
    const matcher = await readMatcher(resolve(this.#workspaceRoot, directory, GITIGNORE_FILENAME))
    this.#matchers.set(directory, matcher)
    return matcher
  }
}
