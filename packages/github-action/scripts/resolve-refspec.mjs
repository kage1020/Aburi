import { spawnSync } from "node:child_process"

const INPUT_ERROR = 2
const FULL_SHA = /^[0-9a-f]{40}$/
const SHALLOW = "This clone is shallow, which aburi diff refuses; check out with fetch-depth: 0."
const WAYS_OUT =
  "Check out the pull request's head or merge ref, or, where the checkout already holds the tree to compare, set the 'refspec' input to name both sides yourself."

/** Ends the step; the message becomes its `::error::` annotation. */
class Refusal extends Error {}

/**
 * A workflow command ends at the newline, so anything after one would land in the log rather than
 * the annotation, and a bare `%` would start one of the runner's escapes.
 */
function annotate(level, message) {
  const line = message.replace(/\s+/g, " ").trim().replaceAll("%", "%25")
  process.stderr.write(`::${level}::${line}\n`)
}

function log(line) {
  process.stderr.write(`${line}\n`)
}

function run(args) {
  const result = spawnSync("git", args, { encoding: "utf8" })
  const said = (result.stderr ?? "").split("\n").find((line) => line.trim() !== "")
  const reason =
    result.error?.message ??
    said?.trim() ??
    (result.signal === null ? "" : `killed by ${result.signal}`)
  return { status: result.status, out: (result.stdout ?? "").trim(), reason }
}

function failed(args, result) {
  return new Refusal(`git ${args.join(" ")} failed (${result.reason || `exit ${result.status}`}).`)
}

function git(args) {
  const result = run(args)
  if (result.status !== 0) throw failed(args, result)
  return result.out
}

/** For a question git answers "no" with exit 1; any other failure still ends the step. */
function gitAnswer(args) {
  const result = run(args)
  if (result.status === 0) return result.out
  if (result.status !== 1) throw failed(args, result)
  if (result.reason !== "") log(`git ${args.join(" ")}: ${result.reason}`)
  return null
}

function isCommit(sha) {
  return gitAnswer(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) !== null
}

function isAncestor(ancestor, descendant) {
  return gitAnswer(["merge-base", "--is-ancestor", ancestor, descendant]) !== null
}

/** The commit object itself, because a shallow clone's graft hides its parents from `rev-parse`. */
function parentsOf(commit) {
  const [header] = git(["cat-file", "commit", commit]).split("\n\n")
  return header
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length))
}

/** `origin/<base.ref>` as the clone fetched it, or `null` when the clone has no such ref. */
function baseBranchTip(ref) {
  const name = `origin/${ref}`
  // `show-ref` tells a missing ref (exit 1) from one that is there but cannot be read (128).
  if (gitAnswer(["show-ref", "--verify", "--quiet", `refs/remotes/${name}`]) === null) return null
  return { name, sha: git(["rev-parse", "--verify", `refs/remotes/${name}^{commit}`]) }
}

function payloadProblem(field, value) {
  if (value === "") return `no ${field}`
  return FULL_SHA.test(value.toLowerCase()) ? null : `${field} '${value}' is not a full commit SHA`
}

function targetHint(event) {
  return event === "pull_request_target"
    ? " Under pull_request_target, actions/checkout checks out the base branch unless it is given a ref."
    : ""
}

function compareHeadWithMergeBase(headSha, baseSha, baseRef) {
  const tracking = baseBranchTip(baseRef)
  const baseInClone = isCommit(baseSha)
  if (tracking === null && !baseInClone) {
    throw new Refusal(
      `Neither origin/${baseRef} nor base.sha ${baseSha} is in this clone, so the pull request's head ${headSha} has nothing to be compared with. Check out with fetch-depth: 0.`,
    )
  }
  if (tracking === null) {
    annotate(
      "warning",
      `origin/${baseRef} is not in this clone, so the pull request's head is compared with its merge base with base.sha alone: if the pull request merged ${baseRef} after base.sha, what ${baseRef} changed up to that merge is reported as the pull request's own. Check out with fetch-depth: 0 to fetch it.`,
    )
  } else if (!baseInClone) {
    log(`base.sha ${baseSha} is not in this clone; using ${tracking.name} alone.`)
  }

  // `merge-base A B C` compares A with a hypothetical merge of B and C, so base.sha can only move
  // the base forward from the tracking ref's: it decides when the base branch was rewritten past it.
  const bases = tracking === null ? [] : [tracking.sha]
  if (baseInClone) bases.push(baseSha)
  const mergeBase = gitAnswer(["merge-base", headSha, ...bases])
  if (mergeBase === null) {
    const against =
      tracking === null
        ? `base.sha ${baseSha}`
        : baseInClone
          ? `${tracking.name} or base.sha ${baseSha}`
          : tracking.name
    throw new Refusal(
      `git found no merge base of the pull request's head ${headSha} with ${against} in this clone.`,
    )
  }
  const byTracking = tracking !== null && isAncestor(mergeBase, tracking.sha)
  log(
    byTracking
      ? `Checked out the pull request's head; comparing it with its merge base with ${tracking.name}, ${mergeBase}.`
      : `Checked out the pull request's head; comparing it with its merge base with base.sha, ${mergeBase}${tracking === null ? "" : `, which ${tracking.name} does not contain`}.`,
  )
  return `${mergeBase}..${headSha}`
}

function compareMergeWithFirstParent(merge, first, baseRef) {
  const tracking = baseBranchTip(baseRef)
  if (tracking === null) {
    log(`origin/${baseRef} is not in this clone, so whether ${first} is on it was not checked.`)
  } else if (!isAncestor(first, tracking.sha)) {
    throw new Refusal(
      `The checkout is ${merge}, the pull request's head merged into ${first}, which is not on ${tracking.name} (${tracking.sha}): the report would describe a merge into some other branch than the pull request's base. ${WAYS_OUT}`,
    )
  }
  log(
    `Checked out ${merge}, the pull request's head merged into ${first}; comparing the merge with that parent.`,
  )
  return `${first}..${merge}`
}

function resolveRefspec() {
  const input = (process.env.INPUT_REFSPEC ?? "").trim()
  if (/[\r\n]/.test(input)) {
    throw new Refusal("The 'refspec' input spans more than one line; give one <base>..<head>.")
  }
  if (input !== "") return input

  const event = process.env.EVENT_NAME ?? ""
  if (event !== "pull_request" && event !== "pull_request_target") {
    throw new Refusal(`No 'refspec' input and event '${event}' does not carry a PR base/head.`)
  }
  const rawBase = process.env.PR_BASE_SHA ?? ""
  const rawHead = process.env.PR_HEAD_SHA ?? ""
  const baseRef = process.env.PR_BASE_REF ?? ""
  const problems = [
    payloadProblem("base.sha", rawBase),
    payloadProblem("head.sha", rawHead),
    baseRef === "" ? "no base.ref" : null,
  ].filter((problem) => problem !== null)
  if (problems.length > 0) {
    throw new Refusal(
      `The ${event} event's payload is malformed (${problems.join("; ")}); refusing to guess the pull request's refs.`,
    )
  }
  const baseSha = rawBase.toLowerCase()
  const headSha = rawHead.toLowerCase()

  const checkedOut = run(["rev-parse", "--verify", "HEAD^{commit}"])
  if (checkedOut.status !== 0) {
    throw new Refusal(
      `Could not read the checked-out commit in ${process.cwd()} (${checkedOut.reason || "git said nothing"}). Without a 'refspec' input the action compares the pull request against what is checked out there.`,
    )
  }
  const head = checkedOut.out
  const shallow = git(["rev-parse", "--is-shallow-repository"]) === "true"

  if (head === headSha) {
    if (shallow) {
      throw new Refusal(`The checkout is the pull request's head ${head}. ${SHALLOW}`)
    }
    return compareHeadWithMergeBase(headSha, baseSha, baseRef)
  }

  const [first, second] = parentsOf(head)
  if (second === headSha) {
    if (shallow) {
      throw new Refusal(
        `The checkout is ${head}, the pull request's head merged into ${first}. ${SHALLOW}`,
      )
    }
    return compareMergeWithFirstParent(head, first, baseRef)
  }

  const tracking = baseBranchTip(baseRef)
  const tail = shallow ? ` ${SHALLOW}` : ""
  if (head === baseSha || (tracking !== null && isAncestor(head, tracking.sha))) {
    throw new Refusal(
      `The checkout is ${head}, a commit on the pull request's base branch ${baseRef}, not the pull request's code: aburi diff scans the checkout as the head, so no ref spec can describe the pull request from here.${targetHint(event)} Check out the pull request's head or merge ref.${tail}`,
    )
  }
  throw new Refusal(
    `The checkout is ${head}: neither the pull request's head ${headSha} nor a merge of it, which is what a plain actions/checkout gives a pull_request event (refs/pull/<n>/merge). aburi diff scans the checkout as the head, so a ref spec naming the pull request would describe a tree it did not compare. ${WAYS_OUT}${tail}`,
  )
}

try {
  process.stdout.write(resolveRefspec())
} catch (error) {
  if (!(error instanceof Refusal)) throw error
  annotate("error", error.message)
  process.exitCode = INPUT_ERROR
}
