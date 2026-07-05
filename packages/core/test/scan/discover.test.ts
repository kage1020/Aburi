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
