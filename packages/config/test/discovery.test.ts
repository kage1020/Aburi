import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findConfig } from "../src/index"

describe("findConfig", () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "aburi-discovery-test-"))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("finds aburi.jsonc in the starting directory", async () => {
    const path = join(tmp, "aburi.jsonc")
    await writeFile(path, "{}", "utf8")
    expect(await findConfig({ cwd: tmp })).toBe(path)
  })

  it("finds aburi.json when jsonc is absent", async () => {
    const path = join(tmp, "aburi.json")
    await writeFile(path, "{}", "utf8")
    expect(await findConfig({ cwd: tmp })).toBe(path)
  })

  it("prefers aburi.jsonc over aburi.json when both exist", async () => {
    const jsonc = join(tmp, "aburi.jsonc")
    await writeFile(jsonc, "{}", "utf8")
    await writeFile(join(tmp, "aburi.json"), "{}", "utf8")
    expect(await findConfig({ cwd: tmp })).toBe(jsonc)
  })

  it("walks up to a parent directory", async () => {
    const path = join(tmp, "aburi.json")
    await writeFile(path, "{}", "utf8")
    const nested = join(tmp, "apps", "billing")
    await mkdir(nested, { recursive: true })
    expect(await findConfig({ cwd: nested })).toBe(path)
  })

  it("prefers the nearest config when multiple ancestors have one", async () => {
    await writeFile(join(tmp, "aburi.json"), "{}", "utf8")
    const inner = join(tmp, "apps", "billing")
    await mkdir(inner, { recursive: true })
    const innerConfig = join(inner, "aburi.json")
    await writeFile(innerConfig, "{}", "utf8")
    expect(await findConfig({ cwd: inner })).toBe(innerConfig)
  })

  it("returns null when no ancestor has a config", async () => {
    const nested = join(tmp, "empty")
    await mkdir(nested, { recursive: true })
    // Walk would eventually hit FS root which definitely has no aburi.json.
    expect(await findConfig({ cwd: nested })).toBe(null)
  })

  it("resolves a relative cwd against process.cwd()", async () => {
    const path = join(tmp, "aburi.json")
    await writeFile(path, "{}", "utf8")
    const prev = process.cwd()
    process.chdir(tmp)
    try {
      expect(await findConfig({ cwd: "." })).toBe(path)
    } finally {
      process.chdir(prev)
    }
  })
})
