// Decide the `<base>..<head>` ref spec this run passes to `aburi diff`, and print it on stdout.
//
// `aburi diff` scans the working tree as the head, whatever the ref spec calls it
// (`docs/design/cli-spec.md`): the `<head>` it is given only labels the report. So the base has to
// be the tree the checkout grew from. A plain `actions/checkout` on `pull_request` checks out
// `refs/pull/<n>/merge`, the pull request's head merged into the base branch as it stands now, and
// the event's `pull_request.base.sha` does not follow the base branch. Once the base branch moves
// past it, comparing that SHA with the merge reports every change the base branch made since as
// the pull request's own, and the `removed` gate fails on deletions the pull request never made.
//
// So the fallback reads what is checked out:
//
// - A merge whose second parent is the pull request's head, which is what the merge ref is:
//   `HEAD^1..HEAD`, what merging the pull request changes on the base branch's tip.
// - The pull request's head itself: the head's merge base with the base branch (`origin/<base.ref>`
//   when the clone has it, and `base.sha`), against the head. That is the pull request's own
//   commits, with nothing the base branch did that the head has not merged.
// - Anything else, such as the base branch a `pull_request_target` checks out by default, is
//   refused: the report would name one tree and describe another, and no ref spec can describe a
//   pull request whose code is not in the checkout.
//
// Full SHAs either way, so the report's header names the trees that were compared. An explicit
// `refspec` is passed through as given and nothing is checked against it.
//
// A committed script rather than a branch inside `action.yml`, for the reason the scripts beside
// it are scripts: a `run:` block is never executed by any test. `test/resolve-refspec.test.ts`
// runs this one against real repositories.
//
// Input is environment plus cwd:
//   INPUT_REFSPEC  the `refspec` input, verbatim.
//   EVENT_NAME     the event that triggered the run.
//   PR_BASE_SHA    the event's `pull_request.base.sha`; empty off a pull request event.
//   PR_HEAD_SHA    the event's `pull_request.head.sha`; likewise.
//   PR_BASE_REF    the event's `pull_request.base.ref`, the base branch's name; likewise.
//   cwd            the checkout `aburi diff` scans; the step runs this from `working-directory`.
//
// Exit codes: 0 with the ref spec on stdout, 2 with a `::error::` line on stderr. Every refusal
// here is a statement about the caller's workflow, which is exit 2 in
// `packages/cli/src/exit-codes.ts` terms.

import { spawnSync } from "node:child_process"

const INPUT_ERROR = 2

/** One line: the Checks UI shows the first line of an annotation and nothing after it. */
function fail(message) {
  process.stderr.write(`::error::${message.replace(/\s+/g, " ").trim()}\n`)
  process.exitCode = INPUT_ERROR
}

/**
 * `git <args>` in the checkout: its trimmed stdout, or `null` and the first line git wrote about
 * why. That line is empty when git said nothing, as `merge-base` does for two unrelated commits.
 */
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" })
  if (result.error !== undefined) return { out: null, reason: result.error.message }
  if (result.status !== 0) {
    const firstLine = (result.stderr ?? "").split("\n").find((line) => line.trim() !== "")
    return { out: null, reason: firstLine?.trim() ?? "" }
  }
  return { out: result.stdout.trim(), reason: "" }
}

/**
 * A shallow clone is the usual reason a parent or a merge base is missing, and the README already
 * requires `fetch-depth: 0`, so a refusal says so when it applies.
 */
function shallowHint() {
  return git(["rev-parse", "--is-shallow-repository"]).out === "true"
    ? " This clone is shallow; check out with fetch-depth: 0."
    : ""
}

/**
 * `pull_request_target` runs in the base branch's context, and `actions/checkout` checks out the
 * base branch there unless it is given a ref: the checkout then holds none of the pull request's
 * code, so no ref spec could make the diff describe it.
 */
function targetHint(event) {
  return event === "pull_request_target"
    ? " Under pull_request_target, actions/checkout checks out the base branch unless it is given a ref, so the pull request's code is not in this checkout."
    : ""
}

/** Whether `sha` names a commit this clone has. */
function isCommit(sha) {
  return git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).out !== null
}

/**
 * The base branch as this clone last fetched it: `origin/<base.ref>`, the remote and the refs
 * `actions/checkout` sets up, which a `fetch-depth: 0` checkout fetches for every branch. `null`
 * when the event names no base ref or the clone does not carry it.
 */
function baseBranchTip() {
  const ref = process.env.PR_BASE_REF ?? ""
  if (ref === "") return null
  const name = `origin/${ref}`
  const sha = git(["rev-parse", "--verify", "--quiet", `refs/remotes/${name}^{commit}`]).out
  return sha === null ? null : { name, sha }
}

function main() {
  const input = process.env.INPUT_REFSPEC ?? ""
  if (input !== "") {
    process.stdout.write(input)
    return
  }

  const event = process.env.EVENT_NAME ?? ""
  if (event !== "pull_request" && event !== "pull_request_target") {
    fail(`No 'refspec' input and event '${event}' does not carry a PR base/head.`)
    return
  }
  const baseSha = (process.env.PR_BASE_SHA ?? "").toLowerCase()
  const headSha = (process.env.PR_HEAD_SHA ?? "").toLowerCase()
  if (baseSha === "" || headSha === "") {
    fail("pull_request event is missing base/head SHAs; refuse to guess.")
    return
  }

  const checkedOut = git(["rev-parse", "--verify", "HEAD^{commit}"])
  if (checkedOut.out === null) {
    fail(
      `Could not read the checked-out commit in ${process.cwd()} (${checkedOut.reason || "git said nothing"}). Without a 'refspec' input the action compares the pull request against what is checked out there.`,
    )
    return
  }
  const head = checkedOut.out

  if (head === headSha) {
    // `base.sha` can be older than a merge of the base branch the pull request has made since,
    // and its merge base with the head is then `base.sha` itself: the comparison would take in
    // every base-branch commit between it and the one merged. The base branch's tracking ref is
    // the branch as it stands now, so its merge base with the head is the last base-branch commit
    // the head contains. `git merge-base <head> <a> <b>` is the best common ancestor of the head
    // with either, so `base.sha` still counts when the base branch was rewritten past it.
    const tracking = baseBranchTip()
    const bases = tracking === null ? [baseSha] : [tracking.sha]
    if (tracking !== null && isCommit(baseSha)) bases.push(baseSha)
    const mergeBase = git(["merge-base", headSha, ...bases])
    if (mergeBase.out === null) {
      fail(
        `Could not find the merge base of the pull request's base ${baseSha} and head ${headSha} (${mergeBase.reason || "they share no history"}).${shallowHint()}`,
      )
      return
    }
    const against = tracking === null ? baseSha : tracking.name
    process.stderr.write(
      `Checked out the pull request's head; comparing it with its merge base with ${against}, ${mergeBase.out}.\n`,
    )
    process.stdout.write(`${mergeBase.out}..${headSha}`)
    return
  }

  // `--quiet` because a commit with one parent is an answer here, not an error.
  const second = git(["rev-parse", "--verify", "--quiet", "HEAD^2"])
  if (second.out === headSha) {
    const first = git(["rev-parse", "--verify", "HEAD^1"])
    if (first.out === null) {
      fail(
        `Could not read the first parent of the merge ${head} (${first.reason || "git said nothing"}).${shallowHint()}`,
      )
      return
    }
    process.stderr.write(
      `Checked out ${head}, the pull request's head merged into ${first.out}; comparing the merge with that parent.\n`,
    )
    process.stdout.write(`${first.out}..${head}`)
    return
  }

  fail(
    `The checkout is ${head}: neither the pull request's head ${headSha} nor a merge of it, which is what a plain actions/checkout gives a pull_request event (refs/pull/<n>/merge). aburi diff scans the checkout as the head, so a ref spec naming the pull request would describe a tree it did not compare.${targetHint(event)} Check out the merge ref or the head, or set the 'refspec' input to name both sides yourself.${shallowHint()}`,
  )
}

main()
