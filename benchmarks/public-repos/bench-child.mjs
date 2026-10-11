#!/usr/bin/env node
import { pathToFileURL } from "node:url"

const [cliEntry, ...argv] = process.argv.slice(2)
const { runCli } = await import(pathToFileURL(cliEntry).href)

const startedAt = process.hrtime.bigint()
let exitCode = 0
let failure = null
try {
  exitCode = await runCli({ argv })
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
  exitCode = 1
}
const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6

process.stdout.write(
  `\n##BENCH##${JSON.stringify({
    wallMs,
    maxRssKb: process.resourceUsage().maxRSS,
    exitCode,
    failure,
  })}\n`,
)
process.exitCode = exitCode
