import { describe, expect, it } from "vitest"
import { readEnv } from "../src"

describe("readEnv — process.env normalisation", () => {
  it("returns null configPath when unset", () => {
    expect(readEnv({}).configPath).toBeNull()
  })

  it("trims whitespace and rejects empty strings", () => {
    expect(readEnv({ ABURI_CONFIG: "  " }).configPath).toBeNull()
    expect(readEnv({ ABURI_CONFIG: "  ./x.json  " }).configPath).toBe("./x.json")
  })

  it("validates ABURI_LOG_LEVEL against the enum", () => {
    expect(readEnv({ ABURI_LOG_LEVEL: "debug" }).logLevel).toBe("debug")
    expect(readEnv({ ABURI_LOG_LEVEL: "bogus" }).logLevel).toBeNull()
  })

  it("reads NO_COLOR / FORCE_COLOR / CI as presence flags", () => {
    expect(readEnv({ NO_COLOR: "1" }).noColor).toBe(true)
    expect(readEnv({}).noColor).toBe(false)
    expect(readEnv({ FORCE_COLOR: "1" }).forceColor).toBe(true)
    expect(readEnv({ CI: "true" }).ci).toBe(true)
  })

  it("treats empty NO_COLOR as unset (standard NO_COLOR spec)", () => {
    expect(readEnv({ NO_COLOR: "" }).noColor).toBe(false)
  })
})
