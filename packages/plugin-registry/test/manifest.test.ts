import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loadPluginManifest, parsePluginManifest, RegistryError } from "../src/index"

const VALID_MANIFEST = `{
  // valid effects plugin
  "$schema": "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
  "name": "effects-foo",
  "version": "1.0.0",
  "type": "effects",
  "xPrefix": "foo",
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [
      { "id": "x-foo:write", "description": "write something" }
    ],
    "effectPrefixes": [],
    "extKinds": [],
    "extKindPrefixes": [],
    "derivedByPrefixes": ["effects-plugin:foo"],
    "frameworks": [],
  }
}`

describe("parsePluginManifest", () => {
  it("accepts JSONC with comments and trailing commas", () => {
    const m = parsePluginManifest(VALID_MANIFEST, "inline")
    expect(m.name).toBe("effects-foo")
    expect(m.type).toBe("effects")
  })

  it("throws on malformed JSON", () => {
    expect(() => parsePluginManifest("{not json", "inline")).toThrowError(RegistryError)
  })

  it("throws on schema violation (wrong $schema)", () => {
    const text = JSON.stringify({
      $schema: "https://example.com/wrong",
      name: "lang-foo",
      version: "1.0.0",
      type: "lang",
      engines: { aburi: "^1.0.0" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: [],
        frameworks: [],
      },
    })
    expect(() => parsePluginManifest(text, "inline")).toThrowError(RegistryError)
  })

  it("throws on schema violation (lang plugin with x-* effects, per schema allOf)", () => {
    const text = JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
      name: "lang-foo",
      version: "1.0.0",
      type: "lang",
      engines: { aburi: "^1.0.0" },
      provides: {
        effects: [{ id: "x-foo:read", description: "x" }],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: [],
        frameworks: [],
      },
    })
    expect(() => parsePluginManifest(text, "inline")).toThrowError(RegistryError)
  })
})

describe("V1a — parsePluginManifest given a key named twice in one object", () => {
  function refusalOf(text: string): RegistryError {
    try {
      parsePluginManifest(text, "inline")
    } catch (error) {
      if (error instanceof RegistryError) return error
      throw error
    }
    throw new Error("expected a RegistryError")
  }

  it("refuses a second name, naming no plugin, before the schema runs", () => {
    const caught = refusalOf(`{ "name": "effects-foo", "name": "effects-bar" }`)
    expect(caught.code).toBe("manifest-invalid")
    expect(caught.plugins).toEqual([])
    expect(caught.message).toBe(
      'Plugin manifest at inline names "name" twice in the top-level object (again at line 1, column 26)',
    )
    expect(caught.cause).toMatchObject({ kind: "repeated", key: "name", owner: [] })
  })

  it("refuses a name repeated after a nested object closes", () => {
    const text = VALID_MANIFEST.replace(
      '"engines": { "aburi": "^1.0.0" },',
      '"engines": { "aburi": "^1.0.0" },\n  "name": "effects-bar",',
    )
    expect(refusalOf(text).cause).toMatchObject({ key: "name", owner: [] })
  })

  it("refuses one inside a nested array element", () => {
    const caught = refusalOf(`{ "provides": { "effects": [{ "id": "x-a:b", "id": "x-a:c" }] } }`)
    expect(caught.cause).toMatchObject({ key: "id", owner: ["provides", "effects", 0] })
  })

  it("refuses __proto__", () => {
    const caught = refusalOf(`{ "__proto__": {} }`)
    expect(caught.cause).toMatchObject({ kind: "prototype-key", key: "__proto__", owner: [] })
    expect(caught.message).toMatch(/never becomes a key the schema can see$/)
  })

  it("reports the repeat, not the schema failure, when a manifest has both", () => {
    const text = VALID_MANIFEST.replace(
      '"name": "effects-foo",',
      '"name": "effects-foo",\n  "name": "effects-bar",',
    ).replace('"type": "effects",', '"type": "bogus",')
    const caught = refusalOf(text)
    expect(caught.plugins).toEqual([])
    expect(caught.cause).toMatchObject({ key: "name" })
    expect(caught.message).not.toMatch(/does not conform/)
  })

  it("reports the syntax error, not the repeat, when a manifest has both", () => {
    expect(refusalOf(`{ "name": "a", "name": "b", "x": }`).code).toBe("manifest-parse-failed")
  })

  it("lets two objects use the same key", () => {
    const text = VALID_MANIFEST.replace(
      '{ "id": "x-foo:write", "description": "write something" }',
      '{ "id": "x-foo:write", "description": "write" }, { "id": "x-foo:read", "description": "read" }',
    )
    expect(parsePluginManifest(text, "inline").provides.effects).toHaveLength(2)
  })
})

describe("parsePluginManifest — a schema failure", () => {
  it("carries ajv's errors as the cause", () => {
    const text = VALID_MANIFEST.replace('"type": "effects",', '"type": "bogus",')
    let caught: unknown
    try {
      parsePluginManifest(text, "inline")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RegistryError)
    expect(Array.isArray((caught as RegistryError).cause)).toBe(true)
  })
})

describe("loadPluginManifest", () => {
  let tmpDir: string
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aburi-registry-test-"))
  })
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("reads a manifest from disk", async () => {
    const path = join(tmpDir, "aburi-plugin.json")
    await writeFile(path, VALID_MANIFEST, "utf8")
    const m = await loadPluginManifest(path)
    expect(m.name).toBe("effects-foo")
  })

  it("throws with a clear message when the path does not exist", async () => {
    await expect(loadPluginManifest(join(tmpDir, "missing.json"))).rejects.toThrowError(
      RegistryError,
    )
  })

  it("surfaces the errno in the read-failure message (regression: Error instances)", async () => {
    let caught: unknown
    try {
      await loadPluginManifest(join(tmpDir, "still-missing.json"))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RegistryError)
    expect((caught as RegistryError).code).toBe("manifest-read-failed")
    expect((caught as RegistryError).message).toMatch(/ENOENT/)
  })

  it("surfaces EISDIR when the path resolves to a directory", async () => {
    let caught: unknown
    try {
      // readFile() on a directory throws SystemError with code "EISDIR" — Error-derived,
      // so a plain-object errno guard would demote it to "unknown".
      await loadPluginManifest(tmpDir)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RegistryError)
    expect((caught as RegistryError).code).toBe("manifest-read-failed")
    expect((caught as RegistryError).message).toMatch(/EISDIR/)
  })
})
