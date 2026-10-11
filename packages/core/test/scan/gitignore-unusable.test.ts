import { join } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CoreError, discoverFiles } from "../../src"

const workspace = useScratchWorkspace("gitignore-unusable")

/** A rule past the length limit. */
const UNUSABLE = "a".repeat(5_000)

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

  it("but not over a real comment or a blank line", async () => {
    await workspace.writeSource("pkg/a.ts", "1")
    await gitignoreIn("pkg", "", `#${UNUSABLE}`, "   ", "*.log")
    expect((await discover()).files.map((f) => f.path)).toEqual(["pkg/a.ts"])
  })

  it("but not over a rule git can never match, which matches nothing as it does in git", async () => {
    await workspace.writeSource("src/a.ts", "1")
    await workspace.writeSource("src/b.ts", "1")
    await gitignoreIn("", "a/[/b", "src/a.ts\\", "src/a.t[s", "src/a[[:nope:]].ts", "src/b.ts")
    expect((await discover()).files.map((f) => f.path)).toEqual(["src/a.ts"])
  })
})
