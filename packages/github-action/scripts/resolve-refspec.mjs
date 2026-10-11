import { spawnSync } from "node:child_process"

const INPUT_ERROR = 2

/** One line: the Checks UI shows the first line of an annotation and nothing after it. */
function fail(message) {
  process.stderr.write(`::error::${message.replace(/\s+/g, " ").trim()}\n`)
  process.exitCode = INPUT_ERROR
}

// `reason` is empty when git said nothing, as `merge-base` does for two unrelated commits.
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" })
  if (result.error !== undefined) return { out: null, reason: result.error.message }
  if (result.status !== 0) {
    const firstLine = (result.stderr ?? "").split("\n").find((line) => line.trim() !== "")
    return { out: null, reason: firstLine?.trim() ?? "" }
  }
  return { out: result.stdout.trim(), reason: "" }
}

function shallowHint() {
  return git(["rev-parse", "--is-shallow-repository"]).out === "true"
    ? " This clone is shallow; check out with fetch-depth: 0."
    : ""
}

function targetHint(event) {
  return event === "pull_request_target"
    ? " Under pull_request_target, actions/checkout checks out the base branch unless it is given a ref, so the pull request's code is not in this checkout."
    : ""
}

function isCommit(sha) {
  return git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).out !== null
}

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
    // A head that merged the base branch since `base.sha` has `base.sha` as its merge base; the
    // tracking ref finds the last base commit it merged. `base.sha` counts if that was rewritten.
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
