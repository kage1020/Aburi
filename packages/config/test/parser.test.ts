import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseConfig, readConfigFile } from "../src/index"
import { configErrorFrom } from "./fixtures/errors"

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
    expect(parseConfig("{}", "inline")).toEqual({})
  })

  it("accepts JSONC with comments and trailing commas", () => {
    const config = parseConfig(VALID_JSONC, "inline")
    expect(config.effects).toEqual(["effects-prisma", "effects-pino"])
    expect(config.components?.[0]?.id).toBe("billing")
  })

  it("C2 allows empty effects array", () => {
    expect(parseConfig(JSON.stringify({ effects: [] }), "inline").effects).toEqual([])
  })

  it("C3 preserves effects order (first-match-wins is consumer-side)", () => {
    const config = parseConfig(
      JSON.stringify({ effects: ["effects-prisma", "effects-stripe"] }),
      "inline",
    )
    expect(config.effects).toEqual(["effects-prisma", "effects-stripe"])
  })

  it("C5 keep/suppress overlap is accepted at parse time (precedence is consumer-side)", () => {
    const config = parseConfig(
      JSON.stringify({ $schema: SCHEMA, suppress: ["logger"], keep: ["logger.audit"] }),
      "inline",
    )
    expect(config.suppress).toEqual(["logger"])
    expect(config.keep).toEqual(["logger.audit"])
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

  it("throws config-parse-failed on a lexical error, with the offset in the message and the parse errors as cause", async () => {
    const caught = await configErrorFrom(() => parseConfig("{not json", "inline"))
    expect(caught.code).toBe("config-parse-failed")
    expect(caught.message).toMatch(/offset \d+/)
    expect(Array.isArray(caught.cause)).toBe(true)
    expect((caught.cause as unknown[]).length).toBeGreaterThan(0)
  })

  it("throws config-invalid on a schema violation, with the ajv errors as cause and their params in the message", async () => {
    const caught = await configErrorFrom(() =>
      parseConfig(JSON.stringify({ $schema: SCHEMA, unknownField: 1 }), "inline"),
    )
    expect(caught.code).toBe("config-invalid")
    expect(Array.isArray(caught.cause)).toBe(true)
    expect((caught.cause as unknown[]).length).toBeGreaterThan(0)
    // ajv params are embedded in the message so log shippers without `cause` still see them.
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

  it("C4 rejects duplicate component ids", async () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      components: [
        { id: "billing", roots: ["apps/a"] },
        { id: "billing", roots: ["apps/b"] },
      ],
    })
    const caught = await configErrorFrom(() => parseConfig(text, "inline"))
    expect(caught.code).toBe("duplicate-component-id")
    expect(caught.value).toBe("billing")
  })

  it("C6 rejects duplicate frameworkHints names", async () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      frameworkHints: [{ name: "acme" }, { name: "acme" }],
    })
    const caught = await configErrorFrom(() => parseConfig(text, "inline"))
    expect(caught.code).toBe("duplicate-hint-name")
    expect(caught.value).toBe("acme")
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

  it("throws config-not-found when the named path holds nothing", async () => {
    // Separate from `config-read-failed` because the remedy differs: a mistyped name is the
    // caller's to fix, a file the filesystem refused is not.
    const caught = await configErrorFrom(() => readConfigFile(join(tmp, "missing.jsonc")))
    expect(caught.code).toBe("config-not-found")
    expect(caught.message).toContain("No config file at ")
    expect(caught.cause).toBeInstanceOf(Error)
  })

  const onPosix = it.skipIf(process.platform === "win32")

  onPosix("throws config-not-found when a path segment is not a directory", async () => {
    // ENOTDIR is the same fact through a different errno: `--config out/aburi.json` where
    // `out` is a file. Windows answers the same path with ENOENT, so only POSIX exercises it.
    const file = join(tmp, "not-a-dir")
    await writeFile(file, "x", "utf8")
    const caught = await configErrorFrom(() => readConfigFile(join(file, "aburi.json")))
    expect(caught.code).toBe("config-not-found")
  })

  it("throws config-read-failed on EISDIR (path is a directory)", async () => {
    // Node's SystemError is an Error-derived instance, which a plain-object errno guard
    // would silently demote to "unknown".
    const caught = await configErrorFrom(() => readConfigFile(tmp))
    expect(caught.code).toBe("config-read-failed")
    expect(caught.message).toMatch(/EISDIR/)
  })
})
