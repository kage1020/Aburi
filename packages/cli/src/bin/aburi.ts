#!/usr/bin/env node
import { runCli } from "../run"

async function main(): Promise<void> {
  const exitCode = await runCli({ argv: process.argv.slice(2) })
  process.exit(exitCode)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
