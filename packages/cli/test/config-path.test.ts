import { describe, expect, it } from "vitest"
import { readEnv, resolveConfigPath } from "../src"

describe("resolveConfigPath — §11 precedence", () => {
  it("returns the CLI flag when both are set (flag > env)", () => {
    const env = readEnv({ ABURI_CONFIG: "./from-env.jsonc" })
    expect(resolveConfigPath("./from-flag.jsonc", env)).toBe("./from-flag.jsonc")
  })

  it("falls back to the env when the CLI flag is undefined", () => {
    const env = readEnv({ ABURI_CONFIG: "./from-env.jsonc" })
    expect(resolveConfigPath(undefined, env)).toBe("./from-env.jsonc")
  })

  it("falls back to the env when the CLI flag is an empty string", () => {
    const env = readEnv({ ABURI_CONFIG: "./from-env.jsonc" })
    expect(resolveConfigPath("", env)).toBe("./from-env.jsonc")
  })

  it("returns undefined when neither is set (on-disk discovery)", () => {
    const env = readEnv({})
    expect(resolveConfigPath(undefined, env)).toBeUndefined()
  })
})
