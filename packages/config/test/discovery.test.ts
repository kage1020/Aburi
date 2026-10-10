import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { ConfigError, findConfig } from "../src/index"

describe("findConfig", () => {
  const scratch = useScratchWorkspace("discovery")

  it.each([
    ["aburi.jsonc", ["aburi.jsonc"]],
    ["aburi.json", ["aburi.json"]],
    ["aburi.jsonc", ["aburi.jsonc", "aburi.json"]],
  ])("finds %s in the starting directory when it holds %j", async (found, names) => {
    for (const name of names) await scratch.writeSource(name, "{}")
    expect(await findConfig({ cwd: scratch.root })).toBe(join(scratch.root, found))
  })

  it("walks up past a package root to an ancestor's config", async () => {
    await scratch.writeSource("aburi.json", "{}")
    const path = join(scratch.root, "aburi.json")
    await scratch.writeSource("apps/billing/package.json", "{}")
    expect(await findConfig({ cwd: join(scratch.root, "apps", "billing") })).toBe(path)
  })

  it("prefers the nearest config when several ancestors have one", async () => {
    await scratch.writeSource("aburi.json", "{}")
    await scratch.writeSource("apps/billing/aburi.json", "{}")
    const inner = join(scratch.root, "apps/billing/aburi.json")
    expect(await findConfig({ cwd: join(scratch.root, "apps", "billing") })).toBe(inner)
  })

  it("returns null when no ancestor has a config", async () => {
    const nested = join(scratch.root, "empty")
    await mkdir(nested)
    expect(await findConfig({ cwd: nested })).toBeNull()
  })

  it("resolves a relative cwd against process.cwd()", async () => {
    await scratch.writeSource("aburi.json", "{}")
    const path = join(scratch.root, "aburi.json")
    const prev = process.cwd()
    process.chdir(scratch.root)
    try {
      expect(await findConfig({ cwd: "." })).toBe(path)
    } finally {
      process.chdir(prev)
    }
  })

  it("refuses a candidate it cannot probe rather than answering that there is none", async () => {
    const cwd = join(scratch.root, "nul\0byte")

    const error = await errorFrom(ConfigError, () => findConfig({ cwd }))

    expect(error.code).toBe("config-read-failed")
    expect(error.message).toContain(join(cwd, "aburi.jsonc"))
  })

  // Windows has no search bit to take away, and root searches a directory whatever its mode.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a candidate in a directory it may not search",
    async () => {
      const locked = join(scratch.root, "locked")
      await mkdir(locked)
      await chmod(locked, 0o000)
      try {
        const error = await errorFrom(ConfigError, () => findConfig({ cwd: locked }))

        expect(error.code).toBe("config-read-failed")
        expect(error.message).toContain("EACCES")
      } finally {
        await chmod(locked, 0o755)
      }
    },
  )
})
