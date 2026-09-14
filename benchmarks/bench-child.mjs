#!/usr/bin/env node
/**
 * One measured `aburi` invocation, isolated in its own process.
 *
 * `run.mjs` spawns this per measurement rather than calling `runCli` in-process for two
 * reasons: a crash or an `process.exitCode` assignment stays contained, and
 * `process.resourceUsage().maxRSS` then reports the peak RSS of *this* run alone instead
 * of the high-water mark of every repo measured so far.
 *
 * Usage: node bench-child.mjs <path-to-cli-entry> <aburi argv...>
 *
 * The measurement is written to stdout as a final `##BENCH##{json}` line. It brackets
 * `runCli` only, so Node's own startup (~40 ms) is excluded and no number here includes it.
 */
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
