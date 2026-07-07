/**
 * §9 — CLI exit code contract. Kept in a named enum-ish object so command handlers use
 * `EXIT.INPUT_ERROR` instead of magic `2`, and the compiler will complain if the value
 * spectrum ever drifts from what the design document promises.
 */
export const EXIT = {
  /** Full success, no CI gate fired. */
  SUCCESS: 0,
  /** Runtime error (IO / git / IR shape). */
  RUNTIME: 1,
  /** Input error (bad argv, missing file, ambiguous explain target). */
  INPUT_ERROR: 2,
  /** Plugin / --fail-on / strict mode violation. */
  GATE: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
