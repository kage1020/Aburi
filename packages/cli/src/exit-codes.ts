/**
 * CLI exit code table — matches the contract in `design/details/cli-spec.md §9`.
 * The `as const` annotation gives every value a literal type so `ExitCode` is a
 * discriminated union of the four numeric literals, not the widened `number`.
 * Individual mappings from CliErrorCode / FailOnParseError to these values live in
 * `run.ts`; that mapping is not enforced by TypeScript here, only by tests.
 */
export const EXIT = {
  /** Full success — the command finished and no CI gate fired. */
  SUCCESS: 0,
  /** Runtime failure (IO, git, filesystem, unexpected exception). */
  RUNTIME: 1,
  /**
   * Input error: bad argv, missing / malformed file, unresolvable IR shape, ambiguous
   * explain target. Configuration and grammar mistakes surface here too so a fail-on
   * typo does not produce a green pipeline.
   */
  INPUT_ERROR: 2,
  /**
   * Plugin load failure, `--fail-on` clause tripped, or strict-mode violation. This is
   * the code CI pipelines gate on ("aburi diff must exit 0 or 3 to be considered
   * healthy").
   */
  GATE: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
