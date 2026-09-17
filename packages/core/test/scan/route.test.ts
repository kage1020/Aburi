import type { LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildLanguageRouter } from "../../src"
import { langManifest, stubLanguagePlugin } from "../fixtures/plugins"

function stubPlugin(name: string, extensions: string[]): LanguagePlugin {
  return stubLanguagePlugin({ manifest: langManifest(name), fileExtensions: extensions })
}

describe("buildLanguageRouter", () => {
  it("routes files to the plugin that declared their extension", () => {
    const ts = stubPlugin("lang-typescript", [".ts", ".tsx"])
    const py = stubPlugin("lang-python", [".py"])
    const router = buildLanguageRouter([ts, py])
    expect(router.route("src/index.ts")).toBe(ts)
    expect(router.route("src/App.tsx")).toBe(ts)
    expect(router.route("scripts/build.py")).toBe(py)
  })

  it("returns null for unknown extensions", () => {
    const router = buildLanguageRouter([stubPlugin("lang-typescript", [".ts"])])
    expect(router.route("README.md")).toBeNull()
    expect(router.route("data.json")).toBeNull()
  })

  it("case-insensitive on extensions", () => {
    const router = buildLanguageRouter([stubPlugin("lang-typescript", [".ts"])])
    expect(router.route("SRC/APP.TS")).not.toBeNull()
  })

  it("throws on extension collision between two different plugins", () => {
    const a = stubPlugin("lang-a", [".ts"])
    const b = stubPlugin("lang-b", [".ts"])
    expect(() => buildLanguageRouter([a, b])).toThrow(/Two language plugins claim/)
  })

  it("permits the same plugin to be listed twice without collision", () => {
    const ts = stubPlugin("lang-typescript", [".ts"])
    expect(() => buildLanguageRouter([ts, ts])).not.toThrow()
  })

  it("knownExtensions lists every registered extension lowercased", () => {
    const router = buildLanguageRouter([stubPlugin("lang-typescript", [".TS", ".Tsx"])])
    expect([...router.knownExtensions].sort()).toEqual([".ts", ".tsx"])
  })
})
