import { component, dependency, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanStubs, stubLanguagePlugin } from "../fixtures/plugins"

const workspace = useScratchWorkspace("component-import-edges")

/** A `.stub` language whose files hold one import specifier per line, refusing `bad.stub` outright. */
const importsPerLine = stubLanguagePlugin({
  parseFile: async (file) => ({
    tree: {},
    errors: file.path.endsWith("/bad.stub")
      ? [{ message: "refused", line: 1, column: 1, recoverable: false }]
      : [],
    imports: file.content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((source, index) => ({ source, symbols: "*", line: index + 1, dynamic: false })),
  }),
})

describe("scan — Component edges", () => {
  it("leaves out the imports of a file the Document leaves out", async () => {
    await workspace.writeSource("web/good.stub", "@acme/shared\n")
    await workspace.writeSource("web/bad.stub", "@acme/api\n")

    const { ir, skipped } = await scanStubs(workspace.root, {
      languages: [importsPerLine],
      components: [
        component({ id: "web", name: "web", roots: ["web"] }),
        component({ id: "shared", name: "shared", roots: ["shared"] }),
        component({ id: "api", name: "api", roots: ["api"] }),
      ],
      workspacePackages: [
        { name: "@acme/shared", root: "shared" },
        { name: "@acme/api", root: "api" },
      ],
    })

    expect(skipped.map((file) => file.path)).toEqual(["web/bad.stub"])
    expect(ir.dependencies).toEqual([dependency({ from: "web", to: "shared" })])
  })
})
