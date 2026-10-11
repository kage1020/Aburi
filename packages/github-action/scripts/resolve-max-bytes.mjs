import { spawnSync } from "node:child_process"

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
  if (rawMaxBytes === "0") return
  if (format === "json") return

  if (runner.length === 0) {
    annotate("error", "resolve-max-bytes.mjs needs the CLI runner as its arguments.")
    process.exitCode = INPUT_ERROR
    return
  }

  const probe = spawnSync(runner[0], [...runner.slice(1), "diff", "--help"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`

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
