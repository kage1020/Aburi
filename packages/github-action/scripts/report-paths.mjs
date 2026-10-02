// Say where `aburi diff` left its reports, as the `diff-json-path` / `diff-md-path` step outputs:
// one `key=value` line each on stdout, for the caller to append to `$GITHUB_OUTPUT`.
//
// A committed script rather than string concatenation in `action.yml`, for the reason the scripts
// beside it are scripts: a `run:` block is never executed by any test. Two things decide the
// answer, and both used to be wrong there:
//
// - **Absolute.** The path is resolved against the directory the CLI ran in, so an absolute
//   `output-dir` stays itself and a relative one gains that directory. The comment step runs
//   from the repository root, and a relative path handed to it — or one it prefixed with
//   `working-directory` — named a file that was not there whenever `output-dir` was absolute.
//   Resolved by Node rather than `$PWD`, because on a Windows runner `$PWD` is an MSYS path
//   (`/d/a/repo`) that Node reads as a directory on the current drive.
// - **Written by this run.** A path is given only for a file that exists after the CLI returns.
//   The CLI removes the reports an earlier run left before it compares anything, so a file here
//   is this run's; a run that stopped first — a plugin that failed to load, which exits 3 like a
//   tripped gate — gives an empty path, and the comment step, which runs only on a non-empty
//   one, is skipped instead of failing on a missing file.
//
// Input is environment only:
//   OUTPUT_DIR  the `output-dir` input, verbatim.
//   FORMAT      the `format` input, so a report this run was not asked for is never named.
//
// Exit code 0 always: the paths are a description of the disk, not a decision.

import { existsSync } from "node:fs"
import { resolve } from "node:path"

// Must equal `DIFF_JSON_FILENAME` / `DIFF_MD_FILENAME` in `@aburi/cli`'s `artifact-paths.ts`;
// `test/action-yml.test.ts` asserts it.
const DIFF_JSON = "diff.json"
const DIFF_MD = "diff.md"

const outputDir = process.env.OUTPUT_DIR || "out"
const format = process.env.FORMAT || "both"

function written(requested, name) {
  if (!requested) return ""
  const path = resolve(process.cwd(), outputDir, name)
  return existsSync(path) ? path : ""
}

const json = written(format === "json" || format === "both", DIFF_JSON)
const md = written(format === "md" || format === "both", DIFF_MD)
process.stdout.write(`diff-json-path=${json}\ndiff-md-path=${md}\n`)
