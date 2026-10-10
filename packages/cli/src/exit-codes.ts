export const EXIT = {
  SUCCESS: 0,
  RUNTIME: 1,
  INPUT_ERROR: 2,
  GATE: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
