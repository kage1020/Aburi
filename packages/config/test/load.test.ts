import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/index"

const SCHEMA = "https://aburi.dev/schema/aburi.config.v1.json"

describe("loadConfig", () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "aburi-load-test-"))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("returns empty config + null source when no config exists (autodetect fallback)", async () => {
    const result = await loadConfig({ cwd: tmp })
    expect(result.config).toEqual({})
    expect(result.source).toBe(null)
    expect(result.syntheticPlugins).toEqual([])
  })

  it("loads a config with frameworkHints and emits synthesized plugins", async () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      frameworkHints: [
        {
          name: "acme",
          decorators: { AcmeController: { extKind: "framework:acme:controller" } },
        },
      ],
    })
    const path = join(tmp, "aburi.jsonc")
    await writeFile(path, text, "utf8")
    const result = await loadConfig({ cwd: tmp })
    expect(result.source).toBe(path)
    expect(result.syntheticPlugins).toHaveLength(1)
    expect(result.syntheticPlugins[0]?.name).toBe("hint-acme")
  })
})
