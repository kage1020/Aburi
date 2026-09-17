import { resolve } from "node:path"

/**
 * Every name the CLI writes into the `--output-dir`, and the directory itself, so external
 * drivers (the GitHub Action, integration fixtures) import the literal rather than copy it.
 * `docs/design/cli-spec.md §6.4` and `diff-algorithm.md §2.3` pin the diff artefacts;
 * `cli-spec.md §5.3` pins the scan's three.
 */

export const DIFF_JSON_FILENAME = "diff.json"
export const DIFF_MD_FILENAME = "diff.md"
export const IR_JSON_FILENAME = "aburi.ir.json"
export const WORKSPACE_MD_FILENAME = "workspace.md"
export const COMPONENTS_DIRNAME = "components"

/** The last fallback, when neither `--output-dir` nor `config.output.dir` names a directory. */
export const DEFAULT_OUTPUT_DIRNAME = "out"

/**
 * The directory a command writes its artefacts into, or reads them back from — against `cwd`,
 * not the workspace root, like every other path-bearing flag. `configured` is
 * `config.output.dir`, which stands exactly where the flag would (`cli-spec.md §5.2`,
 * `config.md §11`) and so resolves against the same directory.
 */
export function resolveOutputDir(
  cwd: string,
  flag: string | undefined,
  configured?: string,
): string {
  return resolve(cwd, flag ?? configured ?? DEFAULT_OUTPUT_DIRNAME)
}
