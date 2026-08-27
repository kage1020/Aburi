import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ConfigError, parseConfig, readConfigFile } from "../src/index"

const SCHEMA = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

const VALID_JSONC = `{
  // comment is allowed
  "$schema": "${SCHEMA}",
  "ignore": ["docs/**"],
  "effects": ["effects-prisma", "effects-pino"],
  "components": [
    { "id": "billing", "roots": ["apps/billing"] },
  ],
  "strict": true
}`

describe("parseConfig", () => {
  it("C1 accepts an empty {} config", () => {
    const config = parseConfig("{}", "inline")
    expect(config).toEqual({})
  })

  it("accepts JSONC with comments and trailing commas", () => {
    const config = parseConfig(VALID_JSONC, "inline")
    expect(config.effects).toEqual(["effects-prisma", "effects-pino"])
    expect(config.components?.[0]?.id).toBe("billing")
  })

  it("C2 allows empty effects array", () => {
    const config = parseConfig(JSON.stringify({ effects: [] }), "inline")
    expect(config.effects).toEqual([])
  })

  it("C3 preserves effects order (first-match-wins is consumer-side)", () => {
    const config = parseConfig(
      JSON.stringify({ effects: ["effects-prisma", "effects-stripe"] }),
      "inline",
    )
    expect(config.effects).toEqual(["effects-prisma", "effects-stripe"])
  })

  it("throws config-parse-failed on lexical error with offset", () => {
    let caught: unknown
    try {
      parseConfig("{not json", "inline")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("config-parse-failed")
    expect((caught as ConfigError).message).toMatch(/offset \d+/)
  })

  it("throws config-invalid on schema violation (wrong $schema)", () => {
    const text = JSON.stringify({ $schema: "https://example.com/wrong" })
    let caught: unknown
    try {
      parseConfig(text, "inline")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("config-invalid")
  })

  it("throws config-invalid on unknown top-level property", () => {
    const text = JSON.stringify({ $schema: SCHEMA, unknownField: 1 })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("throws config-invalid on suppress containing empty string", () => {
    const text = JSON.stringify({ $schema: SCHEMA, suppress: [""] })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("C4 rejects duplicate component ids", () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      components: [
        { id: "billing", roots: ["apps/a"] },
        { id: "billing", roots: ["apps/b"] },
      ],
    })
    let caught: unknown
    try {
      parseConfig(text, "inline")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("duplicate-component-id")
    expect((caught as ConfigError).value).toBe("billing")
  })

  it("C5 keep/suppress overlap is accepted at parse time (precedence is consumer-side)", () => {
    const config = parseConfig(
      JSON.stringify({ $schema: SCHEMA, suppress: ["logger"], keep: ["logger.audit"] }),
      "inline",
    )
    expect(config.suppress).toEqual(["logger"])
    expect(config.keep).toEqual(["logger.audit"])
  })

  it("C6 rejects duplicate frameworkHints names", () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      frameworkHints: [{ name: "acme" }, { name: "acme" }],
    })
    let caught: unknown
    try {
      parseConfig(text, "inline")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("duplicate-hint-name")
    expect((caught as ConfigError).value).toBe("acme")
  })

  it("accepts pluginOptions as an opaque object", () => {
    const config = parseConfig(
      JSON.stringify({
        $schema: SCHEMA,
        pluginOptions: { "effects-prisma": { treatExtendsAsTx: true } },
      }),
      "inline",
    )
    expect(config.pluginOptions?.["effects-prisma"]).toEqual({ treatExtendsAsTx: true })
  })

  it("rejects pluginOptions key violating PluginManifestName pattern", () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      pluginOptions: { "Effects-Prisma": {} },
    })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("rejects ComponentOverride.id violating its kebab-case pattern", () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      components: [{ id: "Billing", roots: ["apps/billing"] }],
    })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("rejects ComponentOverride with empty roots[]", () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      components: [{ id: "billing", roots: [] }],
    })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("rejects Windows-style backslash in RelativePath", () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      components: [{ id: "billing", roots: ["apps\\billing"] }],
    })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("rejects HintRule.extKind that does not start with framework:", () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      frameworkHints: [{ name: "acme", decorators: { X: { extKind: "foo:bar:baz" } } }],
    })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("rejects HintRule.extKind with fewer than three segments (would collide at framework:hint after injection)", () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      frameworkHints: [{ name: "acme", decorators: { X: { extKind: "framework:acme" } } }],
    })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("rejects maxFileSizeBytes below the schema minimum", () => {
    const text = JSON.stringify({ $schema: SCHEMA, maxFileSizeBytes: 512 })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it("rejects classifyTimeoutMs above the schema maximum", () => {
    const text = JSON.stringify({ $schema: SCHEMA, classifyTimeoutMs: 10_000 })
    expect(() => parseConfig(text, "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })
})

describe("readConfigFile", () => {
  let tmp: string
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "aburi-config-test-"))
  })
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("reads + parses + validates a config from disk", async () => {
    const path = join(tmp, "aburi.jsonc")
    await writeFile(path, VALID_JSONC, "utf8")
    const config = await readConfigFile(path)
    expect(config.effects).toEqual(["effects-prisma", "effects-pino"])
  })

  it("throws config-read-failed on ENOENT, exposing errno in the message", async () => {
    let caught: unknown
    try {
      await readConfigFile(join(tmp, "missing.jsonc"))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("config-read-failed")
    expect((caught as ConfigError).message).toMatch(/ENOENT/)
    expect((caught as ConfigError).cause).toBeInstanceOf(Error)
  })

  it("throws config-read-failed on EISDIR (path is a directory, exercises Error-derived getErrno)", async () => {
    let caught: unknown
    try {
      // readFile() on a directory throws SystemError with code "EISDIR" — an Error-derived
      // class instance, which any plain-object errno guard would silently demote to "unknown".
      await readConfigFile(tmp)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("config-read-failed")
    expect((caught as ConfigError).message).toMatch(/EISDIR/)
  })

  it("preserves the parse-error array as cause for config-parse-failed", () => {
    let caught: unknown
    try {
      parseConfig("{ broken", "inline")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("config-parse-failed")
    const cause = (caught as ConfigError).cause
    expect(Array.isArray(cause)).toBe(true)
    expect((cause as unknown[]).length).toBeGreaterThan(0)
  })

  it("preserves the ajv error array as cause for config-invalid", () => {
    let caught: unknown
    try {
      parseConfig(JSON.stringify({ $schema: SCHEMA, unknownField: 1 }), "inline")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("config-invalid")
    const cause = (caught as ConfigError).cause
    expect(Array.isArray(cause)).toBe(true)
    expect((cause as unknown[]).length).toBeGreaterThan(0)
    // ajv params should be embedded in the message so log shippers without cause still see them.
    expect((caught as ConfigError).message).toMatch(/additionalProperty/)
  })
})
