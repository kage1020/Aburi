import { describe, expect, it } from "vitest"
import { normalizeLineTerminators } from "../../src/scan/extract-files"
import { scanStubs, stubLanguagePlugin, useStubWorkspace } from "../fixtures/plugins"

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
    await workspace.writeSource("a.stub", ["one", "two", ""].join(terminator))
    const handed = new Map<string, string>()
    const language = stubLanguagePlugin({
      parseFile: async (file) => {
        handed.set(file.path, file.content)
        return { tree: {}, errors: [], imports: [] }
      },
    })

    await scanStubs(workspace.root, { languages: [language] })

    expect(handed.get("a.stub")).toBe("one\ntwo\n")
  })
})
