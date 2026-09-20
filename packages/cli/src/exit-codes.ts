/**
 * CLI exit code table — matches the contract in `docs/design/cli-spec.md`.
 * `as const` gives every value a literal type so `ExitCode` is a union of the four literals.
 * The mapping from `CliErrorCode` / `FailOnParseError` onto these lives in `run.ts`.
 */
export const EXIT = {
  /** Full success — the command finished and no CI gate fired. */
  SUCCESS: 0,
  /** Runtime failure (IO, git, filesystem, unexpected exception): the machine's to fix. */
  RUNTIME: 1,
  /**
   * Input error: bad argv, a file named and missing or malformed, unresolvable IR shape,
   * ambiguous explain target, a config or `--fail-on` grammar mistake, a ref `aburi diff`
   * cannot resolve, an output path a file already stands on. The line against `RUNTIME` is
   * who has to act (`cli-spec.md`, the exit-code table): a mistyped path is the reader's, a
   * permission is not.
   */
  INPUT_ERROR: 2,
  /**
   * The run did not earn a clean answer: a plugin failed to load, a `--fail-on` clause
   * tripped, strict mode was violated, or the answer itself would not be safe (a scan that did
   * not exit clean; an `aburi explain` about a file the document never analysed). This is the
   * code CI pipelines gate on.
   */
  GATE: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
