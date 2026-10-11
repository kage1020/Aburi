import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

const INPUT_ERROR = 2

function fail(message) {
  process.stderr.write(`${message.replace(/\s+/g, " ").trim()}\n`)
  process.exitCode = INPUT_ERROR
}

function reasonOf(error) {
  if (!(error instanceof Error)) return String(error)
  const code = typeof error.code === "string" ? `${error.code}: ` : ""
  return `${code}${error.message}`
}

function main() {
  const cwd = process.cwd()
  const requireFrom = createRequire(`${cwd}/`)

  let manifestPath
  try {
    manifestPath = requireFrom.resolve("@aburi/cli/package.json")
  } catch (error) {
    fail(
      `@aburi/cli is not resolvable from ${cwd} (${reasonOf(error)}). Install it there, together with the plugins your config names, or set cli=dlx.`,
    )
    return
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    fail(`${manifestPath} could not be read as JSON (${reasonOf(error)}).`)
    return
  }

  const bin = manifest.bin?.aburi
  if (typeof bin !== "string") {
    fail(
      `${manifestPath} declares no "aburi" command in its "bin" field, so there is nothing to run. The @aburi/cli installed there is not the one this action expects.`,
    )
    return
  }

  const binPath = resolve(dirname(manifestPath), bin)
  if (!existsSync(binPath)) {
    fail(
      `@aburi/cli resolves to ${binPath}, which does not exist. A CLI bin is build output: build the workspace before this step, or install a published @aburi/cli, which ships it.`,
    )
    return
  }

  process.stdout.write(binPath)
}

main()
