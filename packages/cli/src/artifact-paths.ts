import { resolve } from "node:path"

/**
 * Every name the CLI writes into the `--output-dir`, and the directory itself.
 *
 * Kept in a dedicated module — not baked into each command's source — so external drivers (the
 * GitHub Action, integration fixtures) can import the exact literal string instead of
 * hard-coding a copy that would drift silently the moment we rename either artefact. That is
 * not hypothetical: `aburi explain` held its own `"out/aburi.ir.json"` beside `aburi scan`'s
 * `resolve(outputDir, "aburi.ir.json")`, and the directory half of the copy drifted first.
 *
 * `docs/design/cli-spec.md §6.4` and `docs/design/diff-algorithm.md §5` pin the diff artefacts
 * to `diff.json` and `diff.md`; `§5.3` pins the scan's three. If either contract changes, this
 * is the sole place that has to move.
 */

export const DIFF_JSON_FILENAME = "diff.json"
export const DIFF_MD_FILENAME = "diff.md"
export const IR_JSON_FILENAME = "aburi.ir.json"
export const WORKSPACE_MD_FILENAME = "workspace.md"
export const COMPONENTS_DIRNAME = "components"

/** Where the artefacts go when `--output-dir` is not given. */
export const DEFAULT_OUTPUT_DIRNAME = "out"

/**
 * The directory a command writes its artefacts into, or reads them back from.
 *
 * Against `cwd`, not the workspace root. The two are the same directory in a single-package
 * repository, and different in a monorepo package — where `aburi scan` wrote to one and
 * `aburi explain` looked in the other, missed, and rescanned. Every other path-bearing flag in
 * the CLI resolves against `cwd`, and a caller standing in a package means that package.
 *
 * One function rather than the expression written out at each command, so the three callers
 * cannot answer differently again. A configuration-supplied default for this directory belongs
 * inside here for the same reason: the callers would otherwise have to be found a second time.
 */
export function resolveOutputDir(cwd: string, flag: string | undefined): string {
  return resolve(cwd, flag ?? DEFAULT_OUTPUT_DIRNAME)
}
