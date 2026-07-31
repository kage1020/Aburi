import { readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { glob } from "tinyglobby"
import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/**
 * Assertions in production code that mint a branded id out of a plain string. `ir-schema.md`
 * §3.5 says there are exactly these, and each carries a comment saying why:
 *
 * - `core/src/id.ts` is the module the whole workspace goes through to obtain a `SymbolId`
 *   or `ComponentId`; both assertions there run behind a full grammar check.
 * - `diff/src/slice.ts` holds the only `SliceId` constructor, plus the one predicate that
 *   takes `unknown` by contract and so has nothing better than an assertion to work with.
 *
 * Test fixtures are the fourth documented boundary and are excluded below: a case that feeds
 * a malformed id to the code that rejects it has to be able to write one. `cli/src/ir-io.ts`
 * is the fifth, but it asserts a whole document (`as unknown as IR`) rather than an id, so it
 * does not match this pattern — invariant #17 is what checks the ids inside it.
 */
const ALLOWED_CAST_SITES: ReadonlyMap<string, number> = new Map([
  ["packages/core/src/id.ts", 2],
  ["packages/diff/src/slice.ts", 2],
])

const CAST_PATTERN = /\bas\s+(SymbolId|ComponentId|SliceId|DependencyEndpoint)\b/g

describe("id brand boundaries", () => {
  it("no production file mints a branded id outside the documented boundaries", async () => {
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

    // Compared as whole maps so the failure names both directions at once: a new cast site,
    // and an allowlisted one that no longer casts (which should be removed from the list
    // rather than left as a licence nobody is using).
    expect(Object.fromEntries([...found].sort())).toEqual(
      Object.fromEntries([...ALLOWED_CAST_SITES].sort()),
    )
  })
})
