import { assertIRIntegrity } from "@aburi/core"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanTypeScript } from "./fixtures/scan"

const BAD_SOURCE = ["export const a\u{1F642} = 1", ""].join("\n")

const workspace = useScratchWorkspace("extraction-boundary")

describe("scan — a file the id grammar cannot express", () => {
  it("withdraws the file, naming it and what the plugin said about it", async () => {
    await workspace.writeSource("src/route.ts", BAD_SOURCE)
    await workspace.writeSource("src/ok.ts", "export function ok() {\n  return 1\n}\n")

    const result = await scanTypeScript(workspace.root)

    expect(result.ir.symbols.map((symbol) => symbol.name)).toEqual(["ok"])
    expect(result.extractionFailures).toEqual([
      {
        file: "src/route.ts",
        message: expect.stringContaining("a\u{1F642}"),
        code: "anonymous-symbol-id-attempted",
      },
    ])
    expect(result.skipped).toEqual([
      {
        path: "src/route.ts",
        reason: "extraction-failed",
        detail: expect.stringContaining("a\u{1F642}"),
      },
    ])
  })

  it("lets a file that imports from it resolve what it can, with no dangling edge", async () => {
    await workspace.writeSource("src/route.ts", BAD_SOURCE)
    await workspace.writeSource(
      "src/app.ts",
      [
        'import { GET } from "./route"',
        "",
        "export function run() {",
        "  return GET()",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanTypeScript(workspace.root)
    const ids = new Set<string>(result.ir.symbols.map((symbol) => symbol.id))

    expect([...ids]).toEqual(["ts:src/app.ts#run"])
    expect(() => assertIRIntegrity(result.ir)).not.toThrow()
    expect(result.ir.dependencies.filter((dependency) => !ids.has(dependency.to))).toEqual([])
    expect(result.unresolvedCalls.map((c) => [c.target, c.bucket])).toEqual([["GET", "no-match"]])
  })
})
