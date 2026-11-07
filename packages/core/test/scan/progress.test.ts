import { useScratchWorkspace } from "@aburi/test-support"
import type { LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { ScanProgress } from "../../src"
import { oneSymbolPerFile, scanStubs } from "../fixtures/plugins"

const workspace = useScratchWorkspace("scan-progress")

async function progressOf(
  files: readonly string[],
  language: LanguagePlugin = oneSymbolPerFile(),
): Promise<ScanProgress[]> {
  for (const name of files) await workspace.writeSource(name, name)
  const seen: ScanProgress[] = []
  await scanStubs(workspace.root, {
    languages: [language],
    onProgress: (progress) => seen.push(progress),
  })
  return seen
}

const extracting = (total: number) =>
  Array.from({ length: total + 1 }, (_, done) => ({ phase: "extracting", done, total }))

describe("scan — progress", () => {
  it("reports each phase in order, counting the files extracted up to all of them", async () => {
    expect(await progressOf(["a.stub", "b.stub", "c.stub"])).toEqual([
      { phase: "discovering" },
      ...extracting(3),
      { phase: "resolving" },
    ])
  })

  it("counts a file whose extraction threw as done", async () => {
    const throwing = oneSymbolPerFile({
      parseFile: async (file) => {
        if (file.path === "boom.stub") throw new Error("stub parseFile exploded")
        return { tree: {}, errors: [], imports: [] }
      },
    })

    expect(await progressOf(["boom.stub", "ok.stub"], throwing)).toEqual([
      { phase: "discovering" },
      ...extracting(2),
      { phase: "resolving" },
    ])
  })

  it("reports the extraction of an empty workspace as done at once", async () => {
    expect(await progressOf([])).toEqual([
      { phase: "discovering" },
      { phase: "extracting", done: 0, total: 0 },
      { phase: "resolving" },
    ])
  })
})
