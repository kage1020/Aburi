import { join } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { listExamples } from "../src/examples"

const workspace = useScratchWorkspace("list-examples")

describe("listExamples", () => {
  it("lists every directory holding a README.md, in name order, past the package's own", async () => {
    await workspace.writeSource("b-second/README.md", "# B\n")
    await workspace.writeSource("a-first/README.md", "# A\n")
    for (const own of ["src", "test", "dist", "node_modules"]) {
      await workspace.writeSource(`${own}/file.ts`, "")
    }
    await workspace.writeSource("package.json", "{}")

    expect(await listExamples(workspace.root)).toEqual([
      join(workspace.root, "a-first"),
      join(workspace.root, "b-second"),
    ])
  })

  it("refuses a directory that is not an example instead of leaving its page out", async () => {
    await workspace.writeSource("a-first/README.md", "# A\n")
    await workspace.writeSource("misnamed/notes.md", "# M\n")

    await expect(listExamples(workspace.root)).rejects.toThrow(/misnamed.*README\.md/)
  })

  it("refuses a package with no examples at all", async () => {
    await workspace.writeSource("src/file.ts", "")

    await expect(listExamples(workspace.root)).rejects.toThrow(/no examples/)
  })
})
