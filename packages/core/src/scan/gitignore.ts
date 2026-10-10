import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import ignore, { type Ignore } from "ignore"
import { CoreError } from "../errors"
import { describeThrown, isVanishedFile } from "./faults"

const GITIGNORE_FILENAME = ".gitignore"

// Regex engines refuse long patterns at lengths that differ by platform; one fixed cap keeps
// the verdict on a rule the same on every machine.
const MAX_RULE_LENGTH = 4096

const QUOTED_RULE_LENGTH = 60

const QUOTED_REASON_HEAD = 40
const QUOTED_REASON_TAIL = 60

/** `"none"` is a directory with no opinion, which a deeper or shallower one may still supply. */
type Verdict = "none" | "ignored" | "kept"

export interface GitignoreTree {
  ignores(path: string): Promise<boolean>
}

export function openGitignoreTree(workspaceRoot: string): GitignoreTree {
  return new GitignoreDescent(resolve(workspaceRoot))
}

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

function assertEveryRuleCompiles(content: string, path: string): void {
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (isDiscardedLine(line)) continue
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

function isDiscardedLine(line: string): boolean {
  return /^\s*$/.test(line) || line.startsWith("#")
}

/** Both ends of a long diagnostic: the kind of failure is at the front, the reason at the back. */
function abbreviate(reason: string): string {
  if (reason.length <= QUOTED_REASON_HEAD + QUOTED_REASON_TAIL) return reason
  return `${reason.slice(0, QUOTED_REASON_HEAD)}…${reason.slice(-QUOTED_REASON_TAIL)}`
}

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
      if (next < 0 || next === subject.length - 1) return verdict
      boundary = next
    }
  }

  async #matcherFor(directory: string): Promise<Ignore | null> {
    const cached = this.#matchers.get(directory)
    if (cached !== undefined) return cached
    const matcher = await readMatcher(resolve(this.#workspaceRoot, directory, GITIGNORE_FILENAME))
    this.#matchers.set(directory, matcher)
    return matcher
  }
}
