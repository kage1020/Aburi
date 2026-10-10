import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { discoverFiles } from "../../src"

const workspace = useScratchWorkspace("scan-discover-unroutable")

async function discover(files: readonly string[]) {
  for (const file of files) await workspace.writeSource(file, "1")
  return discoverFiles({
    workspaceRoot: workspace.root,
    languageExtensions: [".ts"],
    respectGitignore: false,
  })
}

function blaming(segment: string): string {
  return `its path segment "${segment}" contains "#", which a Symbol id is split on, so nothing declared in this file could be given an id`
}

describe("discoverFiles — a name no Symbol id can hold", () => {
  it("records it as unroutable, naming the segment, and keeps walking", async () => {
    const result = await discover(["src/a.ts", "src/od#d.ts", "src/z.ts"])

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts", "src/z.ts"])
    expect(result.skipped).toEqual([
      { path: "src/od#d.ts", reason: "unroutable", detail: blaming("od#d.ts") },
    ])
  })

  it("blames the directory that holds it, not every filename underneath", async () => {
    const result = await discover(["src/v#1/util.ts", "src/v#1/other.ts", "src/ok.ts"])

    expect(result.files.map((f) => f.path)).toEqual(["src/ok.ts"])
    expect(result.skipped.map((s) => [s.path, s.detail])).toEqual([
      ["src/v#1/other.ts", blaming("v#1")],
      ["src/v#1/util.ts", blaming("v#1")],
    ])
  })

  it("names the first offending segment when more than one holds a separator", async () => {
    const result = await discover(["a#1/b#2/c.ts"])
    expect(result.skipped.map((s) => s.detail)).toEqual([blaming("a#1")])
  })

  it("says nothing about one whose extension no plugin claims anyway", async () => {
    const result = await discover(["src/a.ts", "notes#1.txt"])

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts"])
    expect(result.skipped).toEqual([])
  })
})
