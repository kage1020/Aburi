import { describe, expect, it } from "vitest"
import { type AburiEnv, readEnv } from "../src"

describe("readEnv", () => {
  it("reads an empty environment as no overrides", () => {
    expect(readEnv({})).toEqual({
      configPath: null,
      logLevel: null,
      noColor: false,
      forceColor: false,
      ci: false,
    })
  })

  it.each<[NodeJS.ProcessEnv, Partial<AburiEnv>]>([
    [{ ABURI_CONFIG: "  ./x.json  " }, { configPath: "./x.json" }],
    [{ ABURI_CONFIG: "  " }, { configPath: null }],
    [{ ABURI_LOG_LEVEL: "debug" }, { logLevel: "debug" }],
    [{ ABURI_LOG_LEVEL: "bogus" }, { logLevel: null }],
    [
      { NO_COLOR: "1", FORCE_COLOR: "1", CI: "true" },
      { noColor: true, forceColor: true, ci: true },
    ],
    [
      { NO_COLOR: "", CI: " " },
      { noColor: false, ci: false },
    ],
  ])("reads %j as %j", (source, expected) => {
    expect(readEnv(source)).toMatchObject(expected)
  })
})
