import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CoreError } from "../errors"
import { describeThrown, isVanishedFile } from "./faults"
import {
  type GitignoreRules,
  MAX_RULE_LENGTH,
  parseGitignore,
  type RuleTooLong,
  type Verdict,
} from "./gitignore-pattern"

const GITIGNORE_FILENAME = ".gitignore"

// Git skips a rule file this large, counting the newline it appends to what it read.
const MAX_GITIGNORE_BYTES = 100 * 1024 * 1024

const QUOTED_RULE_LENGTH = 60

export interface GitignoreTree {
  ignores(path: string): Promise<boolean>
  ignoresDirectory(path: string): Promise<boolean>
}

export function openGitignoreTree(workspaceRoot: string): GitignoreTree {
  return new GitignoreDescent(resolve(workspaceRoot))
}

async function readMatcher(path: string): Promise<GitignoreRules | null> {
  let size: number
  let parsed: GitignoreRules | RuleTooLong | undefined
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) return null
    size = entry.size
    if (size < MAX_GITIGNORE_BYTES) parsed = parseGitignore(await readFile(path))
  } catch (error) {
    if (isVanishedFile(error)) return null
    throw new CoreError(
      `.gitignore at "${path}" could not be read: ${describeThrown(error)}`,
      { code: "scan-gitignore-unreadable", value: path },
      { cause: error },
    )
  }
  if (parsed === undefined) {
    throw new CoreError(
      `.gitignore at "${path}" is ${size} bytes, too large to read: git skips a rule file of ` +
        `${MAX_GITIGNORE_BYTES} bytes or more`,
      { code: "scan-gitignore-unreadable", value: path },
    )
  }
  if ("kind" in parsed) throw refuseRule(path, parsed)
  return parsed
}

function refuseRule(path: string, rule: RuleTooLong): CoreError {
  return new CoreError(
    `.gitignore at "${path}" line ${rule.line} is not a usable pattern ` +
      `("${quoteHead(rule.text)}", ${rule.byteLength} bytes): it is longer than ` +
      `${MAX_RULE_LENGTH} bytes`,
    { code: "scan-gitignore-unreadable", value: path },
  )
}

// By code point, so the quotation never ends in half a character, and without spreading a rule
// that can run to megabytes.
function quoteHead(text: string): string {
  let head = ""
  let count = 0
  for (const character of text) {
    if (count === QUOTED_RULE_LENGTH) return `${head}…`
    head += character
    count++
  }
  return head
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

  ignoresDirectory(path: string): Promise<boolean> {
    return this.#directoryExcluded(path)
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
