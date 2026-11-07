#!/usr/bin/env node
import { errorCode, errorMessage } from "../errors"
import { runCli } from "../run"

const OUTPUT_STREAMS = { stdout: process.stdout, stderr: process.stderr }
type OutputStream = keyof typeof OUTPUT_STREAMS

// EPIPE is a reader that stopped early (`aburi diff … | head -1`), not a failure of the run. Any other
// refusal is held until the event loop drains: thrown from here it would end the process at the
// write, before `aburi diff` removes its base worktree.
let refused: { stream: OutputStream; reason: string } | null = null
for (const name of ["stdout", "stderr"] as const) {
  OUTPUT_STREAMS[name].on("error", (error: unknown) => {
    if (refused !== null || errorCode(error) === "EPIPE") return
    refused = { stream: name, reason: errorCode(error) ?? errorMessage(error) }
  })
}

// `beforeExit` rather than after `main`, since a write to a pipe can fail after the run returned.
process.once("beforeExit", () => {
  if (refused === null) return
  process.exitCode = 1
  const other: OutputStream = refused.stream === "stdout" ? "stderr" : "stdout"
  OUTPUT_STREAMS[other].write(`aburi: could not write to ${refused.stream}: ${refused.reason}\n`)
})

// `process.exitCode`, never `process.exit()`: exiting at once can cut off output still being
// flushed to a pipe (`aburi scan … | head`).
async function main(): Promise<void> {
  process.exitCode = await runCli({ argv: process.argv.slice(2) })
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`)
  process.exitCode = 1
})
