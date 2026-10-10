import { beforeAll, describe, expect, it } from "vitest"
import { type PackedPackage, packPublishedPackages } from "../src/packed"

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
