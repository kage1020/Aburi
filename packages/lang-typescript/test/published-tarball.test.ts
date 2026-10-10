import { exec } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const run = promisify(exec)

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** The paths `npm pack` would put in this package's tarball, relative to its `package/` prefix. */
async function packedPaths(): Promise<string[]> {
  // `exec` rather than `execFile`: npm is `npm.cmd` on Windows, which only a shell can start.
  const { stdout } = await run("npm pack --dry-run --json", {
    cwd: PACKAGE_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  })
  const [packed] = JSON.parse(stdout) as [{ files: { path: string }[] }]
  return packed.files.map((file) => file.path.replaceAll("\\", "/"))
}

describe("the published tarball", () => {
  it("ships the bundle beside the grammars it loads, and no sources or sourcemaps", async () => {
    const paths = await packedPaths()

    expect(paths).toEqual(
      expect.arrayContaining([
        "dist/index.mjs",
        "dist/index.d.mts",
        "wasm/tree-sitter-typescript.wasm",
        "wasm/tree-sitter-tsx.wasm",
        "wasm/NOTICE",
      ]),
    )
    expect(paths.filter((path) => path.startsWith("src/") || path.endsWith(".map"))).toEqual([])
  }, 120_000)
})
