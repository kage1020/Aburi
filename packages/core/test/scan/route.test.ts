import { describe, expect, it } from "vitest"
import { buildLanguageRouter, CoreError } from "../../src"
import { langManifest, stubLanguagePlugin } from "../fixtures/plugins"

function plugin(name: string, fileExtensions: string[]) {
  return stubLanguagePlugin({ manifest: langManifest(name), fileExtensions })
}

describe("buildLanguageRouter", () => {
  it("routes a file to the plugin that declared its extension, whatever the case", () => {
    const ts = plugin("lang-typescript", [".ts", ".tsx"])
    const py = plugin("lang-python", [".py"])
    const router = buildLanguageRouter([ts, py])
    expect(router.route("src/index.ts")).toBe(ts)
    expect(router.route("src/App.tsx")).toBe(ts)
    expect(router.route("SRC/APP.TS")).toBe(ts)
    expect(router.route("scripts/build.py")).toBe(py)
  })

  it.each([
    "README.md",
    "Makefile",
  ])("answers null for %s, whose extension nobody claims", (path) => {
    const router = buildLanguageRouter([plugin("lang-typescript", [".ts"])])
    expect(router.route(path)).toBeNull()
  })

  it.each([
    ["a decomposed declaration and a composed file name", ".ts\u0301", "src/a.t\u015b"],
    ["a composed declaration and a decomposed file name", ".t\u015b", "src/a.ts\u0301"],
  ])("routes %s to the same plugin", (_label, declared, path) => {
    const owner = plugin("lang-accented", [declared])
    expect(buildLanguageRouter([owner]).route(path)).toBe(owner)
  })

  it("refuses two plugins claiming one extension, naming both", () => {
    const build = () => buildLanguageRouter([plugin("lang-a", [".ts"]), plugin("lang-b", [".TS"])])
    expect(build).toThrow(CoreError)
    expect(build).toThrow(/"lang-a" and "lang-b"/)
  })

  it("lets one plugin be listed twice", () => {
    const ts = plugin("lang-typescript", [".ts"])
    expect(buildLanguageRouter([ts, ts]).route("a.ts")).toBe(ts)
  })

  it("lists every claimed extension lowercased", () => {
    const router = buildLanguageRouter([plugin("lang-typescript", [".TS", ".Tsx"])])
    expect([...router.knownExtensions].sort()).toEqual([".ts", ".tsx"])
  })
})
