// Decide the `--max-bytes` value this run passes to `aburi diff`, and say so on stdout: the
// budget as a bare number, or nothing at all when the flag must not be passed.
//
// A committed script rather than a branch inside `action.yml`, for the reason the CLI resolver
// beside it is one: a `run:` block is never executed by any test, so `test/action-yml.test.ts`
// can only assert that certain strings appear in the YAML. Dropping a guard from that block
// would leave CI green and break every run — and the failure mode here is the quiet one this
// whole change exists to remove, an oversized report and a comment that never posts.
// `test/resolve-max-bytes.test.ts` drives this the way `upsert-comment.test.ts` drives the
// upsert: as a real process, against real CLIs.
//
// Input is environment plus argv:
//   MAX_BYTES  the `max-bytes` action input, verbatim: empty for the default, `0` for no cap.
//   FORMAT     the `format` input, so a run writing no Markdown does not cap one.
//   argv       the resolved CLI runner (`node /path/to/aburi`, `pnpm dlx @aburi/cli@latest`).
//
// Exit codes: 0 decided (stdout holds the budget, or is empty), 2 the caller's `max-bytes` is
// not a byte count. Warnings are `::warning::` lines on stderr, never on stdout, which the
// caller captures.

import { spawnSync } from "node:child_process"

/**
 * GitHub's 65536-byte comment limit less the marker line `upsert-comment.mjs` prepends. Must
 * equal `ABURI_COMMENT_BODY_MAX_BYTES` in `src/comment.ts`; `test/action-yml.test.ts` asserts it.
 */
const DEFAULT_BUDGET = 65507

const INPUT_ERROR = 2

/** One line: the Checks UI shows the first line of an annotation and nothing after it. */
function annotate(level, message) {
  process.stderr.write(`::${level}::${message.replace(/\s+/g, " ").trim()}\n`)
}

function main() {
  const rawMaxBytes = process.env.MAX_BYTES ?? ""
  const format = process.env.FORMAT ?? "both"
  const runner = process.argv.slice(2)

  if (rawMaxBytes !== "" && !/^(0|[1-9][0-9]*)$/.test(rawMaxBytes)) {
    annotate(
      "error",
      `max-bytes must be a non-negative integer, or empty (got '${rawMaxBytes}'). Empty means ${DEFAULT_BUDGET}, the largest report a GitHub comment can hold; 0 means no cap.`,
    )
    process.exitCode = INPUT_ERROR
    return
  }
  // The documented opt-out. `diff.json` was never capped, and this says the Markdown should not
  // be either — the comment step then refuses an oversized body rather than the API doing it.
  if (rawMaxBytes === "0") return
  // Nothing to cap: `--format json` writes no `diff.md`. The CLI would warn and carry on, which
  // is the right answer there and a pointless `--help` probe here.
  if (format === "json") return

  if (runner.length === 0) {
    annotate("error", "resolve-max-bytes.mjs needs the CLI runner as its arguments.")
    process.exitCode = INPUT_ERROR
    return
  }

  // Asked of the CLI rather than assumed of it: `version` pins the CLI while the action is
  // referenced by ref, so an older CLI under a newer action is the documented arrangement, and
  // an option it has never heard of would fail every such run at argv parsing.
  //
  // The output is captured rather than piped into `grep`: `grep -q` closes the pipe at the first
  // match, and a writer still going takes SIGPIPE, which under `pipefail` turns a successful
  // match into a non-zero pipeline. Today's help text fits the pipe buffer; a longer one would
  // have made this a silent, permanent misdetection.
  const probe = spawnSync(runner[0], [...runner.slice(1), "diff", "--help"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`

  // A failed probe is not evidence that the flag is missing — it is a registry outage, a typo in
  // `version`, an EACCES on the store, a CLI that crashes at startup. Saying "this CLI has no
  // --max-bytes" here would name a cause nothing established, and under `comment: false` the job
  // stays green while publishing an oversized artefact for the companion workflow to choke on.
  if (probe.error !== undefined || probe.status !== 0) {
    const reason =
      probe.error instanceof Error
        ? probe.error.message
        : `exit ${String(probe.status ?? "unknown")}`
    const firstLine = output.split("\n").find((line) => line.trim() !== "") ?? "<no output>"
    annotate(
      "warning",
      `Could not ask the CLI whether it supports --max-bytes (${reason}): ${firstLine}. diff.md is written without a size cap, and a report over 65536 bytes will be rejected when it is posted.`,
    )
    return
  }

  if (!output.includes("--max-bytes")) {
    annotate(
      "warning",
      `This @aburi/cli has no --max-bytes, so diff.md is written in full. A report over 65536 bytes is rejected by GitHub when it is posted. Upgrade the CLI: the 'version' input under cli: dlx, or your project's own @aburi/cli under cli: workspace.`,
    )
    return
  }

  process.stdout.write(rawMaxBytes === "" ? String(DEFAULT_BUDGET) : rawMaxBytes)
}

main()
