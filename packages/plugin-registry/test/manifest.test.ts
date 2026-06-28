import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loadPluginManifest, parsePluginManifest, RegistryError } from "../src/index"

const VALID_MANIFEST = `{
  // valid effects plugin
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
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
      $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
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
})
