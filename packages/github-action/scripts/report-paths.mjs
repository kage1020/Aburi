// Say where `aburi diff` left its reports, as the `diff-json-path` / `diff-md-path` step outputs:
// one `key=value` line each on stdout, for the caller to append to `$GITHUB_OUTPUT`.
//
// A committed script rather than string concatenation in `action.yml`, for the reason the scripts
// beside it are scripts: a `run:` block is never executed by any test. Two things decide the
// answer, and both used to be wrong there:
//
// - **Absolute.** The path is resolved against the directory the CLI ran in, so an absolute
//   `output-dir` stays itself and a relative one gains that directory. The comment step runs
//   from the repository root: a relative path handed to it named a file that was not there
//   whenever `working-directory` was not the repository root, and one it prefixed with
//   `working-directory` did whenever `output-dir` was absolute. Resolved from Node's own
//   `process.cwd()` rather than from the shell's `$PWD`, which on a Windows runner is an MSYS
//   path (`/d/a/repo`) Node would read as a directory on the current drive.
// - **Written by this run.** A path is given only for a regular file that exists after the CLI
//   returns. The CLI removes the reports an earlier run left before it compares anything, so on
//   a run that exited 0 or 3 a file here is this run's; a run that stopped first — a plugin that
//   failed to load, which exits 3 like a tripped gate — gives an empty path, and the comment
//   step, which runs only on a non-empty one, is skipped instead of failing on a missing file.
//
// Input is environment only:
//   OUTPUT_DIR  the `output-dir` input, verbatim.
//   FORMAT      the `format` input, so a report this run was not asked for is never named.
//   cwd         the directory the CLI ran in; the diff step runs this script from
//               `working-directory`.
//
// Exit code 0 always: the paths are a description of the disk, not a decision.

import { statSync } from "node:fs"
import { resolve } from "node:path"

// Must equal `DIFF_JSON_FILENAME` / `DIFF_MD_FILENAME` in `@aburi/cli`'s `artifact-paths.ts`;
// `test/report-paths.test.ts` names its fixtures by those constants, so a rename fails there.
const DIFF_JSON = "diff.json"
const DIFF_MD = "diff.md"

const outputDir = process.env.OUTPUT_DIR ?? ""
const format = process.env.FORMAT || "both"

function written(requested, name) {
  if (!requested) return ""
  const path = resolve(process.cwd(), outputDir, name)
  return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : ""
}

const json = written(format === "json" || format === "both", DIFF_JSON)
const md = written(format === "md" || format === "both", DIFF_MD)
process.stdout.write(`diff-json-path=${json}\ndiff-md-path=${md}\n`)
