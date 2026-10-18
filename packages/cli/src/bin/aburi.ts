#!/usr/bin/env node
import { errorCode } from "../errors"
import { runCli } from "../run"

// EPIPE is a reader that stopped early (`aburi diff … | head -1`), not a failure of the run.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: unknown) => {
    if (errorCode(error) !== "EPIPE") throw error
  })
}

// `process.exitCode`, never `process.exit()`: exiting at once can cut off output still being
// flushed to a pipe (`aburi scan … | head`).
async function main(): Promise<void> {
  process.exitCode = await runCli({ argv: process.argv.slice(2) })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
