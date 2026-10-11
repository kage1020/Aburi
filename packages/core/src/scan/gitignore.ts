import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CoreError } from "../errors"
import { describeThrown, isVanishedFile } from "./faults"
import { compileRules, type GitignoreRules, readRuleLines, type Verdict } from "./gitignore-pattern"

const GITIGNORE_FILENAME = ".gitignore"

// Regex engines refuse long patterns at lengths that differ by platform; one fixed cap keeps
// the verdict on a rule the same on every machine.
const MAX_RULE_LENGTH = 4096

const QUOTED_RULE_LENGTH = 60

export interface GitignoreTree {
  ignores(path: string): Promise<boolean>
}

export function openGitignoreTree(workspaceRoot: string): GitignoreTree {
  return new GitignoreDescent(resolve(workspaceRoot))
}

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

/** `rule` is the rule's bytes, one character per byte; the quotation is decoded back to text. */
function refuseRule(path: string, index: number, rule: string, reason: string): CoreError {
  const head = rule.length > QUOTED_RULE_LENGTH ? rule.slice(0, QUOTED_RULE_LENGTH) : rule
  const quoted = Buffer.from(head, "latin1").toString("utf8") + (head === rule ? "" : "…")
  return new CoreError(
    `.gitignore at "${path}" line ${index + 1} is not a usable pattern ("${quoted}", ` +
      `${rule.length} bytes): ${reason}`,
    { code: "scan-gitignore-unreadable", value: path },
  )
}

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

  // Each file judges the candidate alone: an ancestor's exclusion is settled above, across every
  // file, so a deeper file that re-includes a directory is not overruled by a shallower one.
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
      if (next < 0 || next === subject.length - 1) return verdict
      boundary = next
    }
  }

  async #matcherFor(directory: string): Promise<GitignoreRules | null> {
    const cached = this.#matchers.get(directory)
    if (cached !== undefined) return cached
    const matcher = await readMatcher(resolve(this.#workspaceRoot, directory, GITIGNORE_FILENAME))
    this.#matchers.set(directory, matcher)
    return matcher
  }
}
