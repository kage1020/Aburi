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
// Windows has no filename that holds a backslash — the character is its path separator, and
// `writeFile` reads one as a directory boundary — so the fixture can only exist on POSIX. The
// classification itself is `backslashSite`, which `id.test.ts` pins on every platform; what
// these cover is the wiring around it, on ubuntu and macOS.
const onPosix = it.skipIf(process.platform === "win32")

describe("discoverFiles \u2014 a name the Document cannot spell", () => {
  onPosix("reports it instead of renaming it, and keeps walking", async () => {
    // Left to `toDocumentPath`, the backslash was rewritten into a separator and this file
    // reached the IR as `src/weird/name.ts` \u2014 a path nothing can open, carrying Symbol ids
    // nothing can look up.
    await writeFileAt("src/weird\\name.ts", "1")
    await writeFileAt("src/ok.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.skipped).toEqual([])
    expect(result.unrepresentableFiles).toEqual([
      { fsPath: "src/weird\\name.ts", unnameablePrefix: "src/weird\\name.ts" },
    ])
  })

  onPosix("leaves it out of the file set the census is built from", async () => {
    // Neither counted nor recorded, and that pairing is what integrity #21 requires: the skip
    // list's length is `totalFiles - parsedFiles`, so a file counted here and absent from it
    // would make the document fail its own check.
    await writeFileAt("src/weird\\name.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.length + result.skipped.length).toBe(0)
    expect(result.unrepresentableFiles.length).toBe(1)
  })

  onPosix("blames the directory when the directory is what holds it", async () => {
    // A backslash in a directory name disqualifies every file beneath it, and none of those
    // filenames is at fault \u2014 the same reason the id-separator report names a segment.
    await writeFileAt("src/v\\1/util.ts", "1")
    await writeFileAt("src/v\\1/other.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.unrepresentableFiles.map((f) => f.fsPath)).toEqual([
      "src/v\\1/other.ts",
      "src/v\\1/util.ts",
    ])
    // One prefix for both: the directory is the rename, and neither filename is at fault.
    for (const entry of result.unrepresentableFiles) {
      expect(entry.unnameablePrefix).toBe("src/v\\1")
    }
  })

  onPosix("says nothing about one no plugin would have claimed", async () => {
    // The extension filter runs first, for the reason it runs before the id-separator check:
    // a `notes\\1.txt` in a TypeScript workspace was never a candidate, and an incident about
    // it \u2014 one that gates the exit code \u2014 would be about a file the scan was never going to read.
    await writeFileAt("notes\\1.txt", "1")
    await writeFileAt("src/ok.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.unrepresentableFiles).toEqual([])
  })
})

describe("discoverFiles \u2014 the extension filter reads the filesystem's spelling", () => {
  // The filter used to run on the path `toDocumentPath` had already normalized. It runs before
  // that call now \u2014 it has to, because that call refuses the character the check between them
  // reports \u2014 so it normalizes both sides itself. Without that, a file is dropped for the spelling
  // its filesystem happened to hand back, with no record anywhere that it existed.
  //
  // Each direction pins one side: a filesystem cannot be asked to decompose a name, but it can
  // be asked to keep one, so the case is built from whichever of the two the test writes.
  it("matches a composed declaration against a decomposed filename", async () => {
    await writeFileAt("src/a.ts\u0301", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".t\u015b"],
      respectGitignore: false,
    })

    // Accounted for, rather than in `files`: which of the two it lands in depends on whether
    // the filesystem finds a file by a spelling other than the one it stores it under, and
    // this is about the filter, which is what decides between being accounted for at all and
    // being dropped with no record.
    expect(result.files.length + result.skipped.length).toBe(1)
    expect(result.unrepresentableFiles).toEqual([])
  })

  it("matches a decomposed declaration against a composed filename", async () => {
    await writeFileAt("src/b.t\u015b", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts\u0301"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/b.t\u015b"])
  })
})
describe("discoverFiles — what the walk assumes of its glob", () => {
  it("gets `/` as the separator whatever the platform separator is", async () => {
    // `tinyglobby` passes `pathSeparator: "/"` to `fdir`, which is why a backslash in its output
    // is always part of a filename. That is the dependency's behaviour rather than a documented
    // contract, and the whole ordering of the loop rests on it, so a version bump that took it
    // away silently would fail here rather than in a user's IR.
    await writeFileAt("src/nested/deep/a.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/nested/deep/a.ts"])
  })

  onPosix("takes an ignore pattern only with the backslash written twice", async () => {
    // What the scan report tells the reader to do, measured. Patterns reach picomatch, which
    // spends a lone backslash as an escape, so the name as printed does not match itself.
    await writeFileAt("src/v\\1/util.ts", "1")

    const asPrinted = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
      ignore: ["src/v\\1/**"],
    })
    expect(asPrinted.unrepresentableFiles).toHaveLength(1)

    const doubled = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
      ignore: ["src/v\\\\1/**"],
    })
    expect(doubled.unrepresentableFiles).toEqual([])
  })
})
