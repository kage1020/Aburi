#!/usr/bin/env node
import { rmSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { createAburiServer } from "../server"

const USAGE = `Usage: aburi-mcp [--cwd <path>] [--config <path>]

Answers an AI agent's questions about a workspace over MCP on stdio, from runs of the aburi CLI.

Options:
  --cwd <path>     the directory whose workspace it answers about (default: the current one)
  --config <path>  the config file every run reads, as aburi's --config does
  -v, --version    output the version number
  -h, --help       display help
`

function main(): void {
  let parsed: ReturnType<typeof parseOptions>
  try {
    parsed = parseOptions()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  const { version } = createRequire(import.meta.url)("@aburi/mcp/package.json") as {
    version: string
  }
  if (parsed.help === true) {
    process.stdout.write(USAGE)
    return
  }
  if (parsed.version === true) {
    process.stdout.write(`${version}\n`)
    return
  }

  const aburi = createAburiServer({
    cwd: resolve(parsed.cwd ?? "."),
    ...(parsed.config === undefined ? {} : { configPath: resolve(parsed.config) }),
    version,
  })
  const connection = serveStdio(() => aburi.server, {
    onerror: (error) => process.stderr.write(`aburi-mcp: ${error.message}\n`),
  })
  // The process ends by itself once stdin closes; this is the last point that knows the directory.
  process.on("exit", () => rmSync(aburi.directory, { recursive: true, force: true }))
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void connection
        .close()
        .then(() => aburi.close())
        .finally(() => process.kill(process.pid, signal))
    })
  }
}

function parseOptions() {
  return parseArgs({
    options: {
      cwd: { type: "string" },
      config: { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  }).values
}

main()
