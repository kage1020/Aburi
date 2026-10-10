import { readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { glob } from "tinyglobby"
import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

const ALLOWED_CAST_SITES: ReadonlyMap<string, number> = new Map([
  ["packages/core/src/id.ts", 2],
  ["packages/diff/src/slice.ts", 2],
  ["packages/test-support/src/ir.ts", 4],
])

const CAST_PATTERN = /\bas\s+(SymbolId|ComponentId|SliceId|DependencyEndpoint)\b/g

describe("id brand boundaries", () => {
  it("nothing under packages/*/src mints a branded id outside the documented boundaries", async () => {
    const files = await glob(["packages/*/src/**/*.ts"], {
      cwd: REPO_ROOT,
      ignore: ["**/node_modules/**", "**/dist/**"],
      onlyFiles: true,
    })
    expect(files.length).toBeGreaterThan(50)

    const found = new Map<string, number>()
    for (const file of files) {
      const posix = relative(REPO_ROOT, resolve(REPO_ROOT, file)).replaceAll("\\", "/")
      const source = await readFile(resolve(REPO_ROOT, file), "utf8")
      const count = [...source.matchAll(CAST_PATTERN)].length
      if (count > 0) found.set(posix, count)
    }

    expect(Object.fromEntries([...found].sort())).toEqual(
      Object.fromEntries([...ALLOWED_CAST_SITES].sort()),
    )
  })
})
