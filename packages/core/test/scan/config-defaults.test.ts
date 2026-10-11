import configSchema from "@aburi/schema/aburi.config.v1.json" with { type: "json" }
import { describe, expect, it } from "vitest"
import {
  CLASSIFY_TIMEOUT_MAX_MS,
  CLASSIFY_TIMEOUT_MIN_MS,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_PARSE_TIMEOUT_MS,
  isStrict,
  PARSE_TIMEOUT_MIN_MS,
} from "../../src"

const { properties } = configSchema

describe("the scan assumes what the config schema states", () => {
  it.each<[string, unknown, unknown]>([
    [
      "classifyTimeoutMs default",
      DEFAULT_CLASSIFY_TIMEOUT_MS,
      properties.classifyTimeoutMs.default,
    ],
    ["classifyTimeoutMs minimum", CLASSIFY_TIMEOUT_MIN_MS, properties.classifyTimeoutMs.minimum],
    ["classifyTimeoutMs maximum", CLASSIFY_TIMEOUT_MAX_MS, properties.classifyTimeoutMs.maximum],
    ["parseTimeoutMs default", DEFAULT_PARSE_TIMEOUT_MS, properties.parseTimeoutMs.default],
    ["parseTimeoutMs minimum", PARSE_TIMEOUT_MIN_MS, properties.parseTimeoutMs.minimum],
    ["maxFileSizeBytes default", DEFAULT_MAX_FILE_SIZE_BYTES, properties.maxFileSizeBytes.default],
    ["strict default", isStrict({}), properties.strict.default],
  ])("for the %s", (_setting, assumed, stated) => {
    expect(assumed).toBe(stated)
  })
})
