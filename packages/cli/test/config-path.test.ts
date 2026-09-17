import { describe, expect, it } from "vitest"
import { readEnv, resolveConfigPath } from "../src"

describe("resolveConfigPath — precedence", () => {
  it.each([
    ["the CLI flag when both are set (flag > env)", "./from-flag.jsonc", "./from-flag.jsonc"],
    ["the env when the CLI flag is undefined", undefined, "./from-env.jsonc"],
    ["the env when the CLI flag is an empty string", "", "./from-env.jsonc"],
  ])("returns %s", (_, flag, expected) => {
    const env = readEnv({ ABURI_CONFIG: "./from-env.jsonc" })
    expect(resolveConfigPath(flag, env)).toBe(expected)
  })

  it("returns undefined when neither is set (on-disk discovery)", () => {
    expect(resolveConfigPath(undefined, readEnv({}))).toBeUndefined()
  })
})
