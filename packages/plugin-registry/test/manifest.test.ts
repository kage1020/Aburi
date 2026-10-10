import { join } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { loadPluginManifest, parsePluginManifest, RegistryError } from "../src/index"
import { langManifest } from "./fixtures/manifests"

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

function refusalOf(text: string): Promise<RegistryError> {
  return errorFrom(RegistryError, () => parsePluginManifest(text, "inline"))
}

describe("parsePluginManifest", () => {
  it("accepts JSONC with comments and trailing commas", () => {
    const m = parsePluginManifest(VALID_MANIFEST, "inline")
    expect(m.name).toBe("effects-foo")
    expect(m.type).toBe("effects")
  })

  it("refuses text that is not JSONC, saying where", async () => {
    const caught = await refusalOf("{not json")
    expect(caught).toMatchObject({ code: "manifest-parse-failed", plugins: [] })
    expect(caught.message).toMatch(
      /^Plugin manifest at inline is not valid JSONC: .* at offset \d+/,
    )
  })

  it.each([
    ["a wrong $schema", { ...langManifest(), $schema: "https://example.com/wrong" }],
    [
      "a lang plugin declaring x-* effects",
      langManifest({ provides: { effects: [{ id: "x-foo:read", description: "x" }] } }),
    ],
  ])("refuses %s against the schema, naming the plugin and carrying ajv's errors", async (_, m) => {
    const caught = await refusalOf(JSON.stringify(m))
    expect(caught).toMatchObject({ code: "manifest-invalid", plugins: ["lang-foo"] })
    expect(caught.message).toMatch(/^Plugin manifest at inline does not conform to /)
    expect(Array.isArray(caught.cause)).toBe(true)
  })
})

describe("parsePluginManifest given a key named twice in one object", () => {
  it("refuses a second name, naming no plugin, before the schema runs", async () => {
    const caught = await refusalOf(`{ "name": "effects-foo", "name": "effects-bar" }`)
    expect(caught).toMatchObject({ code: "manifest-invalid", plugins: [] })
    expect(caught.message).toBe(
      'Plugin manifest at inline names "name" twice in the top-level object (again at line 1, column 26)',
    )
    expect(caught.cause).toMatchObject({ kind: "repeated", key: "name", owner: [] })
  })

  it("refuses a name repeated after a nested object closes", async () => {
    const text = VALID_MANIFEST.replace(
      '"engines": { "aburi": "^1.0.0" },',
      '"engines": { "aburi": "^1.0.0" },\n  "name": "effects-bar",',
    )
    expect((await refusalOf(text)).cause).toMatchObject({ key: "name", owner: [] })
  })

  it("refuses one inside a nested array element", async () => {
    const caught = await refusalOf(
      `{ "provides": { "effects": [{ "id": "x-a:b", "id": "x-a:c" }] } }`,
    )
    expect(caught.cause).toMatchObject({ key: "id", owner: ["provides", "effects", 0] })
  })

  it("refuses __proto__", async () => {
    const caught = await refusalOf(`{ "__proto__": {} }`)
    expect(caught.cause).toMatchObject({ kind: "prototype-key", key: "__proto__", owner: [] })
    expect(caught.message).toMatch(/never becomes a key the schema can see$/)
  })

  it("reports the repeat, not the schema failure, when a manifest has both", async () => {
    const text = VALID_MANIFEST.replace(
      '"name": "effects-foo",',
      '"name": "effects-foo",\n  "name": "effects-bar",',
    ).replace('"type": "effects",', '"type": "bogus",')
    const caught = await refusalOf(text)
    expect(caught.plugins).toEqual([])
    expect(caught.cause).toMatchObject({ key: "name" })
    expect(caught.message).not.toMatch(/does not conform/)
  })

  it("reports the syntax error, not the repeat, when a manifest has both", async () => {
    expect((await refusalOf(`{ "name": "a", "name": "b", "x": }`)).code).toBe(
      "manifest-parse-failed",
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
  const scratch = useScratchWorkspace("registry-manifest")

  it("reads a manifest from disk", async () => {
    await scratch.writeSource("aburi-plugin.json", VALID_MANIFEST)
    expect((await loadPluginManifest(join(scratch.root, "aburi-plugin.json"))).name).toBe(
      "effects-foo",
    )
  })

  it.each([
    ["is not there", "missing.json", "ENOENT"],
    ["is a directory", ".", "EISDIR"],
  ])("refuses a path that %s, naming the errno", async (_, name, errno) => {
    await expect(loadPluginManifest(join(scratch.root, name))).rejects.toMatchObject({
      code: "manifest-read-failed",
      plugins: [],
      message: expect.stringContaining(`(${errno})`),
    })
  })
})
