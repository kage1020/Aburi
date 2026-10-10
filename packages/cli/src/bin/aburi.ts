#!/usr/bin/env node
import { runCli } from "../run"

// `process.exitCode`, never `process.exit()`: exiting at once can cut off output still being
// flushed to a pipe (`aburi scan … | head`).
async function main(): Promise<void> {
  process.exitCode = await runCli({ argv: process.argv.slice(2) })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
