/**
 * Canonical filenames the CLI writes into the `--output-dir` (default `out/`) for the
 * `aburi diff` subcommand. Kept in a dedicated module — not baked into the diff
 * command's source — so external drivers (the GitHub Action, integration fixtures)
 * can import the exact literal string instead of hard-coding a copy that would drift
 * silently the moment we rename either artefact.
 *
 * `design/details/cli-spec.md §6.4` and `design/details/diff-algorithm.md §5` pin the
 * names to `diff.json` and `diff.md`; if that contract ever changes, this is the sole
 * place that has to move.
 */
export const DIFF_JSON_FILENAME = "diff.json"
export const DIFF_MD_FILENAME = "diff.md"
