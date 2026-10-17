import { join } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it, vi } from "vitest"
import { CoreError, discoverFiles } from "../../src"

// Sizes and decoding failures nobody should have to write to disk to see.
const stubbed = vi.hoisted(() => ({
  sizes: new Map<string, number>(),
  undecodable: new Set<string>(),
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args)
      const size = stubbed.sizes.get(String(args[0]))
      return size === undefined ? stats : Object.assign(stats, { size })
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const content = await actual.readFile(...args)
      if (!stubbed.undecodable.has(String(args[0])) || !Buffer.isBuffer(content)) return content
      return Object.assign(Buffer.from(content), {
        toString: () => {
          throw new RangeError("Cannot create a string longer than 0x1fffffe8 characters")
        },
      })
    },
  }
})

const workspace = useScratchWorkspace("gitignore-unusable")

/** A rule past the length limit. */
const UNUSABLE = "a".repeat(5_000)

const MIB = 1024 * 1024

async function gitignoreIn(directory: string, ...lines: readonly string[]): Promise<void> {
  await workspace.writeSource(join(directory, ".gitignore"), `${lines.join("\n")}\n`)
}

function discover() {
  return discoverFiles({ workspaceRoot: workspace.root, languageExtensions: [".ts"] })
}

async function refusal(): Promise<CoreError> {
  const error = await errorFrom(CoreError, discover)
  expect(error.code).toBe("scan-gitignore-unreadable")
  return error
}

describe("a .gitignore holding a rule that cannot be used ends the walk", () => {
  it("naming the file, by its absolute path", async () => {
    await workspace.writeSource("src/a.ts", "1")
    await gitignoreIn("", UNUSABLE)
    expect((await refusal()).message).toContain(join(workspace.root, ".gitignore"))
  })

  it("naming the nested file, not the root one", async () => {
    await gitignoreIn("", "root.ts")
    await workspace.writeSource("pkg/a.ts", "1")
    await gitignoreIn("pkg", UNUSABLE)

    const { message } = await refusal()
    expect(message).toContain(join(workspace.root, "pkg", ".gitignore"))
    expect(message).not.toContain(join(workspace.root, ".gitignore"))
  })

  it("at one byte past the maximum length, and not at the maximum", async () => {
    await workspace.writeSource("src/a.ts", "1")
    await gitignoreIn("", "a".repeat(4_096))
    expect((await discover()).files.map((f) => f.path)).toEqual(["src/a.ts"])

    await gitignoreIn("", "a".repeat(4_097))
    await refusal()

    // 2,049 two-byte characters are 4,098 bytes.
    await gitignoreIn("", String.fromCodePoint(0xe9).repeat(2_049))
    await refusal()
  })

  it.each([
    ["a negation nothing reaches", [`!${UNUSABLE}`]],
    ["a long rule shadowed by an earlier match", ["a*", UNUSABLE]],
    ["a rule padded past the limit with leading spaces", [`${" ".repeat(5_000)}x`]],
    ["a pseudo-comment, whose # is not the first character", [`  #${UNUSABLE}`]],
  ])("for %s, which the walk itself would never have asked about", async (_label, rules) => {
    await workspace.writeSource("pkg/a.ts", "1")
    await gitignoreIn("pkg", ...rules)
    expect((await refusal()).message).toContain(join(workspace.root, "pkg", ".gitignore"))
  })

  it("naming the line, quoting only the head of the rule", async () => {
    await workspace.writeSource("pkg/a.ts", "1")
    await gitignoreIn("pkg", "# a comment", "", "*.log", UNUSABLE)

    const { message } = await refusal()
    expect(message).toContain("line 4")
    expect(message).toContain("5000 bytes")
    expect(message.length).toBeLessThan(1_000)
  })

  it("quoting whole characters, not a character cut in half", async () => {
    await workspace.writeSource("src/a.ts", "1")
    await gitignoreIn("", `${"a".repeat(59)}é${UNUSABLE}`)

    const { message } = await refusal()
    expect(message).toContain(`"${"a".repeat(59)}é…"`)
    expect(message).not.toContain("�")
  })

  it("but not over a real comment or a blank line", async () => {
    await workspace.writeSource("pkg/a.ts", "1")
    await gitignoreIn("pkg", "", `#${UNUSABLE}`, "   ", "*.log")
    expect((await discover()).files.map((f) => f.path)).toEqual(["pkg/a.ts"])
  })

  it("but not over a rule git can never match, which matches nothing as it does in git", async () => {
    await workspace.writeSource("src/a.ts", "1")
    await workspace.writeSource("src/b.ts", "1")
    await gitignoreIn("", "a/[/b", "src/a.ts\\", "src/a.t[s", "src/a.t[[:nope:]]", "src/b.ts")
    expect((await discover()).files.map((f) => f.path)).toEqual(["src/a.ts"])
  })
})

describe("a .gitignore that cannot be read into rules ends the walk", () => {
  it("at the size git skips such a file at, without reading it, and not a byte below", async () => {
    await workspace.writeSource("src/a.ts", "1")
    await workspace.writeSource("src/b.ts", "1")
    await gitignoreIn("", "src/b.ts")
    const path = join(workspace.root, ".gitignore")

    stubbed.sizes.set(path, 100 * MIB - 1)
    expect((await discover()).files.map((f) => f.path)).toEqual(["src/a.ts"])

    stubbed.sizes.set(path, 100 * MIB)
    const { message } = await refusal().finally(() => stubbed.sizes.delete(path))
    expect(message).toContain(path)
    expect(message).toContain(`${100 * MIB} bytes`)
  })

  it("naming the file when its content cannot be decoded", async () => {
    await workspace.writeSource("src/a.ts", "1")
    await gitignoreIn("", "src/b.ts")
    const path = join(workspace.root, ".gitignore")

    stubbed.undecodable.add(path)
    const { message } = await refusal().finally(() => stubbed.undecodable.delete(path))
    expect(message).toContain(path)
    expect(message).toContain("longer than 0x1fffffe8 characters")
  })
})
