export const EXIT = {
  /** Full success — the command finished and no CI gate fired. */
  SUCCESS: 0,
  /** Runtime failure (IO, git, filesystem, unexpected exception): the machine's to fix. */
  RUNTIME: 1,
  INPUT_ERROR: 2,
  GATE: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
