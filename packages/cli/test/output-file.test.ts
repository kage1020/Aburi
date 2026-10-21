import { readdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it, vi } from "vitest"
import { removeOutputFileOpeningWith } from "../src/output-file"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    open: async (path: string) => {
      const handle = await actual.open(path)
      return {
        read: (buffer: Buffer, offset: number, length: number, position: number) =>
          handle.read(buffer, offset, Math.min(length, 3), position),
        close: () => handle.close(),
      }
    },
  }
})

const workspace = useScratchWorkspace("output-file")

describe("a file removed by its first line, on a filesystem that reads a few bytes at a time", () => {
  it.each([
    ["removes one that opens with that line", "# Component: beta\n\n**Name**: beta\n", []],
    ["keeps one whose first line goes on past it", "# Component: beta extra notes\n", ["beta.md"]],
  ])("%s", async (_, contents, left) => {
    const path = resolve(workspace.root, "beta.md")
    await writeFile(path, contents, "utf8")

    await removeOutputFileOpeningWith(
      { command: "scan", artefact: "the Markdown for component beta", path },
      "# Component: beta",
    )

    expect(await readdir(workspace.root)).toEqual(left)
  })
})
