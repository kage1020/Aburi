#!/usr/bin/env node
import { runCli } from "../run"

async function main(): Promise<void> {
  process.exitCode = await runCli({ argv: process.argv.slice(2) })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
