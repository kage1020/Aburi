// Print the absolute path of the `aburi` bin belonging to the `@aburi/cli` installed in the
// current working directory, or explain in one line why there is none.
//
// This is what `cli: workspace` runs the CLI through. It resolves the package rather than a
// `node_modules/.bin/aburi` link because that link is not reliably there: a workspace that builds
// its own CLI has no bin file when the install writes the links, so the link is skipped, and a
// later install does not recreate it — the tree is up to date by then. See
// `docs/design/github-action.md` §3 for the whole story; this file is its implementation.
//
// Plain `.mjs`, committed rather than built, because a consumer references the action by path
// (`uses: kage1020/Aburi/packages/github-action@main`) and nothing builds this repository for them.
//
// Exit codes: 0 with the path on stdout, or 2 with one line on stderr. Every failure here is a
// statement about the caller's setup — which is exit 2 in `packages/cli/src/exit-codes.ts` terms,
// and the code the action propagates for its own input errors.

import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

const INPUT_ERROR = 2

/**
 * `process.exitCode` rather than `process.exit()`: a write to a pipe is asynchronous on macOS, and
 * exiting in the same tick can truncate the message the caller is about to quote back.
 *
 * Collapsed to one line because the caller renders it as a `::error::` annotation, and the Checks
 * UI shows the first line of one.
 */
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
  // The trailing slash makes the argument a directory rather than a file inside it, so resolution
  // starts at `<cwd>/node_modules` and walks up from there — the project's tree, never this file's.
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

  // Only the map form is accepted. npm names a string `bin` after the package, which for
  // `@aburi/cli` would be `cli`, so a string here is never the `aburi` command.
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
