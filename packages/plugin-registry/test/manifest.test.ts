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

describe("parsePluginManifest — a key named twice in one object", () => {
  function refusalOf(text: string): RegistryError {
    try {
      parsePluginManifest(text, "inline")
    } catch (error) {
      if (error instanceof RegistryError) return error
      throw error
    }
    throw new Error("expected a RegistryError")
  }

  it("refuses a second name, which would otherwise register the plugin under it", () => {
    const text = VALID_MANIFEST.replace(
      '"name": "effects-foo",',
      '"name": "effects-foo",\n  "name": "effects-bar",',
    )
    const caught = refusalOf(text)
    expect(caught.code).toBe("manifest-invalid")
    expect(caught.plugins).toEqual([])
    expect(caught.message).toBe(
      'Plugin manifest at inline names "name" twice in the top-level object (again at line 5, column 3)',
    )
    expect(caught.cause).toEqual({ key: "name", path: [], line: 5, column: 3 })
  })

  it("refuses one inside a nested array element", () => {
    const text = VALID_MANIFEST.replace(
      '{ "id": "x-foo:write", "description": "write something" }',
      '{ "id": "x-foo:write", "description": "write something", "id": "x-foo:read" }',
    )
    expect(refusalOf(text).message).toBe(
      'Plugin manifest at inline names "id" twice in /provides/effects/0 (again at line 11, column 64)',
    )
  })

  it("refuses __proto__, which replaces the prototype where the schema cannot see it", () => {
    const text = VALID_MANIFEST.replace(
      '"xPrefix": "foo",',
      '"xPrefix": "foo",\n  "__proto__": {},',
    )
    expect(refusalOf(text).message).toBe(
      'Plugin manifest at inline names "__proto__" as a key in the top-level object (at line 8, column 3); ' +
        "it replaces the object's prototype instead of adding a key, so the schema cannot see it",
    )
  })

  it("lets two objects use the same key", () => {
    const text = VALID_MANIFEST.replace(
      '{ "id": "x-foo:write", "description": "write something" }',
      '{ "id": "x-foo:write", "description": "write" }, { "id": "x-foo:read", "description": "read" }',
    )
    expect(parsePluginManifest(text, "inline").provides.effects).toHaveLength(2)
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
