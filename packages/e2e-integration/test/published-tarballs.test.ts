import { beforeAll, describe, expect, it } from "vitest"
import { type PackedPackage, packPublishedPackages } from "../src/packed"

/**
 * What a consumer actually receives from npm.
 *
 * The suites around this one exercise `dist/` through the workspace link, so a build-time
 * regression already goes red. The publish seam is what they cannot see: `files` decides
 * the tarball, `lang-typescript/wasm` is gitignored build output that has to ship anyway,
 * and nothing about either shows up in a test that imports the package by name.
 *
 * `test.dependsOn: ["^build"]` is what makes this checkable — every published package is a
 * devDependency of this one precisely so turbo builds all of them before this runs.
 */

const PUBLISHED_PACKAGE_COUNT = 17

let packed: PackedPackage[]
let langTypescript: PackedPackage

beforeAll(async () => {
  packed = await packPublishedPackages()
  const found = packed.find((entry) => entry.name === "@aburi/lang-typescript")
  if (found === undefined) throw new Error("@aburi/lang-typescript is not a published package")
  langTypescript = found
}, 120_000)

describe("e2e: published tarball contents", () => {
  it("covers every published package", () => {
    expect(packed).toHaveLength(PUBLISHED_PACKAGE_COUNT)
  })

  it("builds every package before packing it", () => {
    // A tarball with no dist/ would satisfy the assertions below vacuously.
    const unbuilt = packed
      .filter((entry) => !entry.paths.some((path) => path.startsWith("dist/")))
      .map((entry) => entry.name)
    expect(unbuilt).toEqual([])
  })

  it("ships the grammar wasms with @aburi/lang-typescript", () => {
    expect(langTypescript.paths).toEqual(
      expect.arrayContaining([
        "dist/index.mjs",
        "dist/index.d.mts",
        "wasm/NOTICE",
        "wasm/tree-sitter-typescript.wasm",
        "wasm/tree-sitter-tsx.wasm",
      ]),
    )
  })

  it("keeps the entry exactly one directory below the package root", () => {
    // `src/parser.ts` reaches the grammars through `../wasm/`, relative to the module's
    // own URL. A nested entry would resolve that outside the package.
    expect("dist/index.mjs".split("/")).toHaveLength(2)
    expect(langTypescript.paths).toContain("dist/index.mjs")
  })

  it("ships no TypeScript sources", () => {
    const sources = langTypescript.paths.filter((path) => path.startsWith("src/"))
    expect(sources).toEqual([])
  })

  it("ships no sourcemaps in any package", () => {
    const maps = packed.flatMap((entry) =>
      entry.paths.filter((path) => path.endsWith(".map")).map((path) => `${entry.name}/${path}`),
    )
    expect(maps).toEqual([])
  })
})
