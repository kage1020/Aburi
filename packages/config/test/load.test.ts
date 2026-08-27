import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConfigError, loadConfig } from "../src/index"

const SCHEMA = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

describe("loadConfig", () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "aburi-load-test-"))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("returns the autodetect fallback (found=false) when no config exists", async () => {
    const result = await loadConfig({ cwd: tmp })
    expect(result.found).toBe(false)
    if (result.found) throw new Error("type narrowing unreachable")
    expect(result.config).toEqual({})
    expect(result.source).toBe(null)
    expect(result.syntheticPlugins).toEqual([])
  })

  it("loads a config with frameworkHints and emits synthesized plugins (found=true)", async () => {
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
    expect(result.found).toBe(true)
    if (!result.found) throw new Error("type narrowing unreachable")
    expect(result.source).toBe(path)
    expect(result.syntheticPlugins).toHaveLength(1)
    expect(result.syntheticPlugins[0]?.name).toBe("hint-acme")
  })

  it("propagates config-parse-failed end-to-end", async () => {
    await writeFile(join(tmp, "aburi.json"), "{ not valid", "utf8")
    let caught: unknown
    try {
      await loadConfig({ cwd: tmp })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("config-parse-failed")
  })

  it("propagates reserved-namespace end-to-end", async () => {
    const text = JSON.stringify({
      $schema: SCHEMA,
      frameworkHints: [
        {
          name: "acme",
          decorators: { X: { extKind: "framework:hint:acme:controller" } },
        },
      ],
    })
    await writeFile(join(tmp, "aburi.jsonc"), text, "utf8")
    let caught: unknown
    try {
      await loadConfig({ cwd: tmp })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).code).toBe("reserved-namespace")
  })

  it("walks ancestor directories to find the nearest config", async () => {
    const root = join(tmp, "aburi.jsonc")
    await writeFile(root, "{}", "utf8")
    const nested = join(tmp, "apps", "billing", "src")
    await mkdir(nested, { recursive: true })
    const result = await loadConfig({ cwd: nested })
    expect(result.found).toBe(true)
    if (!result.found) throw new Error("type narrowing unreachable")
    expect(result.source).toBe(root)
  })

  it("prefers aburi.jsonc over aburi.json at the same level", async () => {
    const jsonc = join(tmp, "aburi.jsonc")
    await writeFile(jsonc, "{}", "utf8")
    await writeFile(join(tmp, "aburi.json"), "{}", "utf8")
    const result = await loadConfig({ cwd: tmp })
    expect(result.found).toBe(true)
    if (!result.found) throw new Error("type narrowing unreachable")
    expect(result.source).toBe(jsonc)
  })
})
