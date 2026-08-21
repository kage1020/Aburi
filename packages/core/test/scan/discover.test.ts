import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverFiles } from "../../src"

let workRoot: string

beforeEach(async () => {
  workRoot = join(tmpdir(), `aburi-scan-discover-${Math.floor(performance.now() * 1000)}`)
  await mkdir(workRoot, { recursive: true })
})

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await rm(workRoot, { recursive: true, force: true })
})

async function writeFileAt(rel: string, content: string): Promise<void> {
  const abs = join(workRoot, rel)
  const dir = abs.slice(0, Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\")))
  await mkdir(dir, { recursive: true })
  await writeFile(abs, content, "utf8")
}

describe("discoverFiles", () => {
  it("returns POSIX-relative paths sorted asciibetically", async () => {
    await writeFileAt("src/a.ts", "1")
    await writeFileAt("src/b.ts", "1")
    await writeFileAt("src/nested/c.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/nested/c.ts"])
    expect(result.skipped).toEqual([])
  })

  it("applies the core Category A ignore patterns (node_modules / dist / *.d.ts)", async () => {
    await writeFileAt("src/keep.ts", "1")
    await writeFileAt("node_modules/foo/index.ts", "1")
    await writeFileAt("dist/build.ts", "1")
    await writeFileAt("src/types.d.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/keep.ts"])
  })

  it("merges config.ignore[] into the drop set", async () => {
    await writeFileAt("src/keep.ts", "1")
    await writeFileAt("src/generated.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      ignore: ["src/generated.ts"],
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/keep.ts"])
  })

  it("merges language-plugin fileDropPatterns", async () => {
    await writeFileAt("src/keep.ts", "1")
    await writeFileAt("src/config.d.mts", "1")
    await writeFileAt("src/lib.tsbuildinfo", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      langDropPatterns: ["**/*.tsbuildinfo"],
      languageExtensions: [".ts", ".mts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path).sort()).toEqual(["src/keep.ts"])
  })

  it("skips files over maxFileSizeBytes and records them in skipped", async () => {
    await writeFileAt("src/small.ts", "small")
    await writeFileAt("src/huge.ts", "x".repeat(2048))

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      maxFileSizeBytes: 1024,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/small.ts"])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.path).toBe("src/huge.ts")
    expect(result.skipped[0]?.reason).toBe("over-size")
  })

  it("filters by languageExtensions when provided", async () => {
    await writeFileAt("src/a.ts", "1")
    await writeFileAt("src/b.py", "1")
    await writeFileAt("src/c.md", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts", ".py"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.py"])
  })

  it("returns every discovered file when languageExtensions is omitted", async () => {
    await writeFileAt("src/a.ts", "1")
    await writeFileAt("src/b.md", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.md"])
  })

  it("honors .gitignore patterns when respectGitignore is true (default)", async () => {
    await writeFileAt("src/keep.ts", "1")
    await writeFileAt("src/secret.ts", "1")
    await writeFileAt(".gitignore", "secret.ts\n")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/keep.ts"])
  })

  it("does not read .gitignore when respectGitignore is false", async () => {
    await writeFileAt("src/keep.ts", "1")
    await writeFileAt("src/secret.ts", "1")
    await writeFileAt(".gitignore", "secret.ts\n")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path).sort()).toEqual(["src/keep.ts", "src/secret.ts"])
  })
})

/**
 * A name Aburi cannot build an id from is one file, not the end of the walk.
 *
 * `#` rather than `:` in every fixture here: `:` is a legal POSIX filename character and the
 * grammar refuses both, but NTFS reads it as an alternate-data-stream separator, so a `:` file
 * would pass on Linux and macOS and silently be a different file on Windows. The grammar-level
 * case covers `:` without touching a filesystem.
 */
const DETAIL_PREFIX = "its path segment "
const DETAIL_SUFFIX =
  ' contains "#", which a Symbol id is split on, so nothing declared in this file could be given an id'

describe("discoverFiles — a name no Symbol id can hold", () => {
  it("records it and keeps walking", async () => {
    await writeFileAt("src/a.ts", "1")
    await writeFileAt("src/od#d.ts", "1")
    await writeFileAt("src/z.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts", "src/z.ts"])
    expect(result.skipped).toEqual([
      {
        path: "src/od#d.ts",
        reason: "unroutable",
        detail: `${DETAIL_PREFIX}"od#d.ts"${DETAIL_SUFFIX}`,
      },
    ])
  })

  it("blames the segment that holds it, not every filename underneath", async () => {
    // A separator in a directory name disqualifies every file beneath it, and none of those
    // filenames is at fault. Reported as "its name contains", `src/v#1/util.ts` sends the reader
    // to rename `util.ts`, which fixes nothing and loses the one name that would.
    await writeFileAt("src/v#1/util.ts", "1")
    await writeFileAt("src/v#1/other.ts", "1")
    await writeFileAt("src/ok.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.skipped.map((s) => s.path)).toEqual(["src/v#1/other.ts", "src/v#1/util.ts"])
    for (const entry of result.skipped) {
      expect(entry.detail).toBe(`${DETAIL_PREFIX}"v#1"${DETAIL_SUFFIX}`)
    }
  })

  it("names the first offending segment when more than one holds a separator", async () => {
    await writeFileAt("a#1/b#2/c.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.skipped[0]?.detail).toBe(`${DETAIL_PREFIX}"a#1"${DETAIL_SUFFIX}`)
  })

  it("leaves it out of the skip list when no plugin claims its extension anyway", async () => {
    // The extension filter runs first. `notes#1.txt` in a TypeScript workspace was never a
    // candidate, and an incident about a file the scan was never going to read is noise.
    await writeFileAt("src/a.ts", "1")
    await writeFileAt("notes#1.txt", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts"])
    expect(result.skipped).toEqual([])
  })

  it("counts it against the workspace, not against the plugin set", async () => {
    // `unroutable` covers both producers now: the router refusing an extension, and the id
    // grammar refusing a name. Same answer — no route into the Document exists for this file,
    // decided before it was read — with `detail` saying which.
    await writeFileAt("src/od#d.ts", "1")
    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })
    expect(result.skipped[0]?.detail).not.toContain("plugin")
    expect(result.skipped[0]?.detail).not.toContain("Symbol id path")
  })
})
