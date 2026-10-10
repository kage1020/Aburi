import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { noopRegistry } from "@aburi/test-support"
import type { OpaqueAstNode, ParseResult, SourceFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { scan } from "../../src"
import { normalizeLineTerminators } from "../../src/scan/scan"
import { stubLanguagePlugin, useStubWorkspace } from "../fixtures/plugins"

describe("normalizeLineTerminators", () => {
  it("turns CRLF and a lone CR into LF, and leaves LF alone", () => {
    expect(normalizeLineTerminators("a\r\nb\rc\nd\r\n\r\ne\r")).toBe("a\nb\nc\nd\n\ne\n")
  })

  it("returns LF-only content unchanged", () => {
    const content = "export const a = 1\n"
    expect(normalizeLineTerminators(content)).toBe(content)
  })
})

describe("scan hands a language plugin LF-only content", () => {
  const workspace = useStubWorkspace("line-terminators")

  it.each([
    ["CRLF", "\r\n"],
    ["a lone CR", "\r"],
  ])("reads a file saved with %s as LF", async (_name, terminator) => {
    await writeFile(join(workspace.root, "a.stub"), ["one", "two", ""].join(terminator), "utf8")
    const handed = new Map<string, string>()
    const language = stubLanguagePlugin({
      parseFile: async (file: SourceFile): Promise<ParseResult> => {
        handed.set(file.path, file.content)
        return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
      },
    })

    await scan({
      workspaceRoot: workspace.root,
      config: {},
      languages: [language],
      frameworks: [],
      effects: [],
      registry: noopRegistry,
      components: [],
    })

    expect(handed.get("a.stub")).toBe("one\ntwo\n")
  })
})
