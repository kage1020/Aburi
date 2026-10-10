import { chmod, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CoreError, discoverFiles } from "../../src"

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

  it("raises a coded error when .gitignore is there and cannot be used", async () => {
    await writeFileAt("src/a.ts", "1")
    await writeFileAt(".gitignore", `${"a".repeat(5_000)}\n`)

    const thrown = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CoreError)
    expect((thrown as CoreError).code).toBe("scan-gitignore-unreadable")
    expect((thrown as CoreError).message).toContain(join(workRoot, ".gitignore"))
  })

  it("treats a directory named .gitignore as no patterns at all, as git does", async () => {
    await writeFileAt("src/a.ts", "1")
    await mkdir(join(workRoot, ".gitignore"))

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts"])
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
const onPosix = it.skipIf(process.platform === "win32")

describe("discoverFiles \u2014 a name the Document cannot spell", () => {
  onPosix("reports it instead of renaming it, and keeps walking", async () => {
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
      {
        fsPath: "src/weird\\name.ts",
        reason: "unspellable-name",
        unnameablePrefix: "src/weird\\name.ts",
      },
    ])
  })

  onPosix("leaves it out of the file set the census is built from", async () => {
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
      expect(entry.reason === "unspellable-name" && entry.unnameablePrefix).toBe("src/v\\1")
    }
  })

  onPosix("says nothing about one no plugin would have claimed", async () => {
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
  it("matches a composed declaration against a decomposed filename", async () => {
    await writeFileAt("src/a.ts\u0301", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".t\u015b"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/a.t\u015b"])
    expect(result.skipped).toEqual([])
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
    await writeFileAt("src/nested/deep/a.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/nested/deep/a.ts"])
  })

  onPosix("takes an ignore pattern only with the backslash written twice", async () => {
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
const onCollidingFs = it.skipIf(process.platform === "darwin")

describe("discoverFiles — a name the filesystem and the Document spell differently", () => {
  it("opens the file by the name on disk and records the normalized one", async () => {
    await writeFileAt("src/caf\u0065\u0301.ts", "1234")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.skipped).toEqual([])
    expect(result.files).toEqual([
      { path: "src/caf\u00e9.ts", fsPath: "src/caf\u0065\u0301.ts", size: 4 },
    ])
  })

  it("leaves the two the same string for a name that is already NFC", async () => {
    await writeFileAt("src/plain.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files).toEqual([{ path: "src/plain.ts", fsPath: "src/plain.ts", size: 1 }])
  })

  onCollidingFs("withdraws both when two spellings claim one Document path", async () => {
    await writeFileAt("src/caf\u0065\u0301.ts", "1")
    await writeFileAt("src/caf\u00e9.ts", "22")
    await writeFileAt("src/ok.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.skipped).toEqual([])
    expect(result.unrepresentableFiles).toEqual([
      {
        fsPath: "src/caf\u0065\u0301.ts",
        reason: "colliding-spelling",
        documentPath: "src/caf\u00e9.ts",
      },
      {
        fsPath: "src/caf\u00e9.ts",
        reason: "colliding-spelling",
        documentPath: "src/caf\u00e9.ts",
      },
    ])
  })

  onCollidingFs(
    "withdraws a claimant that would have been skipped, not only a read one",
    async () => {
      await writeFileAt("src/caf\u0065\u0301.ts", "12345")
      await writeFileAt("src/caf\u00e9.ts", "1")

      const result = await discoverFiles({
        workspaceRoot: workRoot,
        languageExtensions: [".ts"],
        respectGitignore: false,
        maxFileSizeBytes: 2,
      })

      expect(result.files).toEqual([])
      expect(result.skipped).toEqual([])
      expect(result.unrepresentableFiles).toHaveLength(2)
    },
  )

  onCollidingFs(
    "withdraws a pair whose Document path an earlier arm would have skipped",
    async () => {
      await writeFileAt("src/v#1/caf\u0065\u0301.ts", "1")
      await writeFileAt("src/v#1/caf\u00e9.ts", "22")

      const result = await discoverFiles({
        workspaceRoot: workRoot,
        languageExtensions: [".ts"],
        respectGitignore: false,
      })

      expect(result.skipped).toEqual([])
      expect(result.files).toEqual([])
      expect(result.unrepresentableFiles).toEqual([
        {
          fsPath: "src/v#1/caf\u0065\u0301.ts",
          reason: "colliding-spelling",
          documentPath: "src/v#1/caf\u00e9.ts",
        },
        {
          fsPath: "src/v#1/caf\u00e9.ts",
          reason: "colliding-spelling",
          documentPath: "src/v#1/caf\u00e9.ts",
        },
      ])
    },
  )

  onCollidingFs("holds a group of three, since nothing about the rule caps it at two", async () => {
    await writeFileAt("src/b\u1ec7.ts", "1")
    await writeFileAt("src/b\u0065\u0323\u0302.ts", "22")
    await writeFileAt("src/b\u1eb9\u0302.ts", "333")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
    })

    expect(result.unrepresentableFiles).toHaveLength(3)
    for (const entry of result.unrepresentableFiles) {
      expect(entry.reason === "colliding-spelling" && entry.documentPath).toBe("src/b\u1ec7.ts")
    }
  })

  onCollidingFs("leaves no Document path claimed twice, whichever arm produced it", async () => {
    await writeFileAt("src/caf\u0065\u0301.ts", "1")
    await writeFileAt("src/caf\u00e9.ts", "22")
    await writeFileAt("src/v#1/na\u0065\u0301.ts", "1")
    await writeFileAt("src/v#1/na\u00e9.ts", "22")
    await writeFileAt("src/big\u0065\u0301.ts", "1234567")
    await writeFileAt("src/big\u00e9.ts", "1")
    await writeFileAt("src/ok.ts", "1")

    const result = await discoverFiles({
      workspaceRoot: workRoot,
      languageExtensions: [".ts"],
      respectGitignore: false,
      maxFileSizeBytes: 4,
    })

    const named = [...result.files, ...result.skipped].map((entry) => entry.path)
    expect(new Set(named).size).toBe(named.length)
    expect(named).toEqual(["src/ok.ts"])
  })
})

const asUnprivilegedPosixUser = it.skipIf(process.platform === "win32" || process.getuid?.() === 0)

describe("discoverFiles — a candidate the stat cannot reach", () => {
  asUnprivilegedPosixUser("ends the run when the failure is the machine's", async () => {
    await writeFileAt("src/sealed/a.ts", "1")
    await writeFileAt("src/plain.ts", "1")
    const sealed = join(workRoot, "src", "sealed")
    await chmod(sealed, 0o444)

    try {
      await expect(
        discoverFiles({
          workspaceRoot: workRoot,
          languageExtensions: [".ts"],
          respectGitignore: false,
        }),
      ).rejects.toThrow(/EACCES/)
    } finally {
      await chmod(sealed, 0o755)
    }
  })

  asUnprivilegedPosixUser("throws the operating system's own account of it", async () => {
    await writeFileAt("src/sealed/a.ts", "1")
    const sealed = join(workRoot, "src", "sealed")
    await chmod(sealed, 0o444)

    try {
      const thrown = await discoverFiles({
        workspaceRoot: workRoot,
        languageExtensions: [".ts"],
        respectGitignore: false,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      expect((thrown as { code?: string }).code).toBe("EACCES")
      expect((thrown as Error).message).toContain(join(workRoot, "src", "sealed", "a.ts"))
    } finally {
      await chmod(sealed, 0o755)
    }
  })
})
