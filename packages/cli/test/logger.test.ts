import { describe, expect, it } from "vitest"
import type { LogLevel } from "../src/env"
import { createLogger } from "../src/logger"

describe("createLogger", () => {
  it.each<{ minimum: LogLevel | undefined; expected: string[] }>([
    { minimum: undefined, expected: ["warn: w\n", "error: e\n"] },
    { minimum: "debug", expected: ["debug: d\n", "info: i\n", "warn: w\n", "error: e\n"] },
    { minimum: "error", expected: ["error: e\n"] },
  ])("prints $minimum and above (default: warn)", ({ minimum, expected }) => {
    const lines: string[] = []
    const logger = createLogger({
      ...(minimum === undefined ? {} : { minimum }),
      write: (line) => lines.push(line),
    })
    logger.debug?.("d")
    logger.info?.("i")
    logger.warn?.("w")
    logger.error?.("e")
    expect(lines).toEqual(expected)
  })
})
