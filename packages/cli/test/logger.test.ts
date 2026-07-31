import { describe, expect, it } from "vitest"
import { createLogger } from "../src/logger"

/**
 * `ABURI_LOG_LEVEL` is parsed by `readEnv` and handed to `runScan`, which builds
 * the run's logger from it. Before that path existed the level was read and then
 * dropped, and `debug` / `info` were hard-coded no-ops — so a pass that logged a
 * degraded operation at debug level could not be heard from at any setting.
 */
describe("createLogger", () => {
  it("prints warn and above by default", () => {
    const lines: string[] = []
    const logger = createLogger({ write: (line) => lines.push(line) })
    emitAll(logger)
    expect(lines).toEqual(["warn: w\n", "error: e\n"])
  })

  it("prints every level once the minimum is debug", () => {
    const lines: string[] = []
    const logger = createLogger({ minimum: "debug", write: (line) => lines.push(line) })
    emitAll(logger)
    expect(lines).toEqual(["debug: d\n", "info: i\n", "warn: w\n", "error: e\n"])
  })

  it("prints only errors once the minimum is error", () => {
    const lines: string[] = []
    const logger = createLogger({ minimum: "error", write: (line) => lines.push(line) })
    emitAll(logger)
    expect(lines).toEqual(["error: e\n"])
  })
})

function emitAll(logger: ReturnType<typeof createLogger>): void {
  logger.debug?.("d")
  logger.info?.("i")
  logger.warn?.("w")
  logger.error?.("e")
}
