import { join } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { ConfigError, parseConfig, readConfigFile } from "../src/index"
import { CONFIG_SCHEMA as SCHEMA } from "./fixtures/configs"

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
  it("accepts JSONC with comments and trailing commas", () => {
    const config = parseConfig(VALID_JSONC, "inline")
    expect(config.effects).toEqual(["effects-prisma", "effects-pino"])
    expect(config.components?.[0]?.id).toBe("billing")
  })

  it.each([
    ["an empty config", {}],
    ["an empty effects array", { effects: [] }],
    ["effects in the order written", { effects: ["effects-prisma", "effects-stripe"] }],
    [
      "keep and suppress that overlap",
      { $schema: SCHEMA, suppress: ["logger"], keep: ["logger.audit"] },
    ],
    [
      "pluginOptions as an opaque object",
      { $schema: SCHEMA, pluginOptions: { "effects-prisma": { treatExtendsAsTx: true } } },
    ],
  ])("accepts %s as written", (_, config) => {
    expect(parseConfig(JSON.stringify(config), "inline")).toEqual(config)
  })

  it("throws config-parse-failed on a lexical error, with the offset in the message and the parse errors as cause", async () => {
    const caught = await errorFrom(ConfigError, () => parseConfig("{not json", "inline"))
    expect(caught.code).toBe("config-parse-failed")
    expect(caught.message).toMatch(/offset \d+/)
    expect(Array.isArray(caught.cause)).toBe(true)
    expect((caught.cause as unknown[]).length).toBeGreaterThan(0)
  })

  it("throws config-invalid on a schema violation, with the ajv errors as cause and their params in the message", async () => {
    const caught = await errorFrom(ConfigError, () =>
      parseConfig(JSON.stringify({ $schema: SCHEMA, unknownField: 1 }), "inline"),
    )
    expect(caught.code).toBe("config-invalid")
    expect(Array.isArray(caught.cause)).toBe(true)
    expect((caught.cause as unknown[]).length).toBeGreaterThan(0)
    expect(caught.message).toMatch(/additionalProperty/)
  })

  it.each([
    ["a wrong $schema", { $schema: "https://example.com/wrong" }],
    ["suppress containing an empty string", { $schema: SCHEMA, suppress: [""] }],
    [
      "a pluginOptions key violating the PluginManifestName pattern",
      { $schema: SCHEMA, pluginOptions: { "Effects-Prisma": {} } },
    ],
    [
      "a ComponentOverride.id violating its kebab-case pattern",
      { $schema: SCHEMA, components: [{ id: "Billing", roots: ["apps/billing"] }] },
    ],
    [
      "a ComponentOverride with empty roots[]",
      { $schema: SCHEMA, components: [{ id: "billing", roots: [] }] },
    ],
    [
      "a Windows-style backslash in a RelativePath",
      { $schema: SCHEMA, components: [{ id: "billing", roots: ["apps\\billing"] }] },
    ],
    [
      "a HintRule.extKind that does not start with framework:",
      {
        $schema: SCHEMA,
        frameworkHints: [{ name: "acme", decorators: { X: { extKind: "foo:bar:baz" } } }],
      },
    ],
    [
      // Fewer than three segments would collide at `framework:hint` after injection.
      "a HintRule.extKind with fewer than three segments",
      {
        $schema: SCHEMA,
        frameworkHints: [{ name: "acme", decorators: { X: { extKind: "framework:acme" } } }],
      },
    ],
    ["maxFileSizeBytes below the schema minimum", { $schema: SCHEMA, maxFileSizeBytes: 512 }],
    ["classifyTimeoutMs above the schema maximum", { $schema: SCHEMA, classifyTimeoutMs: 10_000 }],
  ])("throws config-invalid on %s", (_label, config) => {
    expect(() => parseConfig(JSON.stringify(config), "inline")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    )
  })

  it.each([
    [
      "component ids",
      {
        components: [
          { id: "billing", roots: ["apps/a"] },
          { id: "billing", roots: ["apps/b"] },
        ],
      },
      "duplicate-component-id",
      "billing",
      'declares components[].id "billing" more than once',
    ],
    [
      "frameworkHints names",
      { frameworkHints: [{ name: "acme" }, { name: "acme" }] },
      "duplicate-hint-name",
      "acme",
      'declares frameworkHints[].name "acme" more than once',
    ],
  ])("rejects duplicate %s, naming the value", async (_, config, code, value, message) => {
    const text = JSON.stringify({ $schema: SCHEMA, ...config })
    const caught = await errorFrom(ConfigError, () => parseConfig(text, "inline"))
    expect(caught).toMatchObject({ code, value })
    expect(caught.message).toBe(`Config at inline ${message}`)
  })
})

describe("a key named twice in one object", () => {
  it.each([
    [
      "at the top level",
      `{ "ignore": ["a/**"], "ignore": ["b/**"] }`,
      'names "ignore" twice in the top-level object (again at line 1, column 23)',
    ],
    [
      "inside an array element",
      `{\n  "components": [{ "id": "a", "roots": ["x"], "id": "b" }]\n}`,
      'names "id" twice in /components/0 (again at line 2, column 47)',
    ],
    [
      "inside a nested object",
      `{ "output": { "dir": "x", "dir": "y" } }`,
      'names "dir" twice in /output (again at line 1, column 27)',
    ],
  ])("refuses the config %s", async (_label, text, message) => {
    const caught = await errorFrom(ConfigError, () => parseConfig(text, "inline"))
    expect(caught.code).toBe("config-invalid")
    expect(caught.message).toBe(`Config at inline ${message}`)
  })

  it("carries the key and where it is as the cause", async () => {
    const text = `{ "output": { "dir": "x", "dir": "y" } }`
    const caught = await errorFrom(ConfigError, () => parseConfig(text, "inline"))
    expect(caught.cause).toEqual({
      kind: "repeated",
      key: "dir",
      owner: ["output"],
      line: 1,
      column: 27,
      offset: 26,
      length: 5,
    })
  })

  it("refuses __proto__, which never becomes a key the schema can see", async () => {
    const text = `{ "__proto__": { "output": { "dir": "smuggled-out" } } }`
    const caught = await errorFrom(ConfigError, () => parseConfig(text, "inline"))
    expect(caught.code).toBe("config-invalid")
    expect(caught.message).toBe(
      'Config at inline names "__proto__" as a key in the top-level object (at line 1, column 3); ' +
        "the parser assigns it instead of defining it, so it never becomes a key the schema can see",
    )
  })

  it("reports the repeat, not the schema failure, when a config has both", async () => {
    const text = `{ "unknownField": 1, "ignore": ["a/**"], "ignore": ["b/**"] }`
    const caught = await errorFrom(ConfigError, () => parseConfig(text, "inline"))
    expect(caught.cause).toMatchObject({ kind: "repeated", key: "ignore" })
    expect(caught.message).not.toMatch(/does not conform/)
  })

  it("lets two objects use the same key", () => {
    const text = `{ "components": [{ "id": "a", "roots": ["x"] }, { "id": "b", "roots": ["y"] }] }`
    expect(parseConfig(text, "inline").components).toHaveLength(2)
  })
})

describe("readConfigFile", () => {
  const scratch = useScratchWorkspace("config")

  it("reads, parses and validates a config from disk", async () => {
    await scratch.writeSource("aburi.jsonc", VALID_JSONC)
    const path = join(scratch.root, "aburi.jsonc")
    expect((await readConfigFile(path)).effects).toEqual(["effects-prisma", "effects-pino"])
  })

  it.each([
    ["holds nothing", "missing.jsonc"],
    ["runs through a file", "not-a-dir/aburi.json"],
  ])("throws config-not-found when the named path %s", async (_, rel) => {
    await scratch.writeSource("not-a-dir", "x")
    const caught = await errorFrom(ConfigError, () => readConfigFile(join(scratch.root, rel)))
    expect(caught.code).toBe("config-not-found")
    expect(caught.message).toBe(`No config file at ${join(scratch.root, rel)}`)
    expect(caught.cause).toBeInstanceOf(Error)
  })

  it("throws config-read-failed on EISDIR (path is a directory)", async () => {
    const caught = await errorFrom(ConfigError, () => readConfigFile(scratch.root))
    expect(caught.code).toBe("config-read-failed")
    expect(caught.message).toMatch(/EISDIR/)
  })
})
