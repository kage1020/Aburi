#!/usr/bin/env node
import { runCli } from "../run"

/**
 * Setting `process.exitCode` (instead of calling `process.exit`) lets Node drain
 * stdout / stderr and any pending `Writable.finish` events before terminating.
 * `process.exit()` under a pipe (`aburi scan --quiet | head`) can truncate the last
 * few bytes because it aborts on the exit-code call before the write buffer flushes.
 */
async function main(): Promise<void> {
  process.exitCode = await runCli({ argv: process.argv.slice(2) })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
