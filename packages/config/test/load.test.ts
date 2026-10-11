import { join } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { ConfigError, configSourceFrom, loadConfig, loadConfigFrom } from "../src/index"
import { CONFIG_SCHEMA } from "./fixtures/configs"

const AUTODETECT = { found: false, source: null, config: {}, syntheticPlugins: [] }

const WITH_HINT = JSON.stringify({
  $schema: CONFIG_SCHEMA,
  frameworkHints: [
    { name: "acme", decorators: { AcmeController: { extKind: "framework:acme:controller" } } },
  ],
})

describe("loadConfig", () => {
  const scratch = useScratchWorkspace("load")

  it("falls back to autodetect when no config exists", async () => {
    expect(await loadConfig({ cwd: scratch.root })).toEqual(AUTODETECT)
  })

  it("loads the config it finds, with one synthesized plugin per frameworkHints entry", async () => {
    await scratch.writeSource("aburi.jsonc", WITH_HINT)
    const path = join(scratch.root, "aburi.jsonc")
    const result = await loadConfig({ cwd: scratch.root })
    expect(result).toMatchObject({ found: true, source: path })
    expect(result.syntheticPlugins.map((p) => p.manifest.name)).toEqual(["hint-acme"])
  })

  it.each([
    ["config-parse-failed", "aburi.json", "{ not valid"],
    [
      "reserved-namespace",
      "aburi.jsonc",
      JSON.stringify({
        $schema: CONFIG_SCHEMA,
        frameworkHints: [
          { name: "acme", decorators: { X: { extKind: "framework:hint:acme:controller" } } },
        ],
      }),
    ],
  ])("propagates %s end-to-end", async (code, filename, text) => {
    await scratch.writeSource(filename, text)
    const caught = await errorFrom(ConfigError, () => loadConfig({ cwd: scratch.root }))
    expect(caught.code).toBe(code)
  })
})

describe("loadConfigFrom", () => {
  const scratch = useScratchWorkspace("load-from")

  it("reads the file a source names, whatever discovery would have found", async () => {
    await scratch.writeSource("settings/custom.jsonc", WITH_HINT)
    const path = join(scratch.root, "settings/custom.jsonc")
    const result = await loadConfigFrom(configSourceFrom(path))
    expect(result).toMatchObject({ found: true, source: path })
    expect(result.syntheticPlugins.map((p) => p.manifest.name)).toEqual(["hint-acme"])
  })

  it("answers config-not-found for a named file that is not there, not autodetect", async () => {
    const source = configSourceFrom(join(scratch.root, "aburi.json"))
    expect((await errorFrom(ConfigError, () => loadConfigFrom(source))).code).toBe(
      "config-not-found",
    )
  })

  it("autodetects when discovery found nothing", async () => {
    expect(configSourceFrom(null)).toEqual({ kind: "autodetect" })
    expect(await loadConfigFrom(configSourceFrom(null))).toEqual(AUTODETECT)
  })
})
