import { component, dependency, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type { Component, SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { scanStubs, stubCandidate, stubLanguagePlugin } from "../fixtures/plugins"

const workspace = useScratchWorkspace("component-import-edges")

function twin(file: string, line: number): SymbolCandidate {
  return stubCandidate("same", {
    file,
    source: { file, startLine: line, endLine: line + 1, startColumn: null, endColumn: null },
  })
}

/**
 * A `.stub` language whose files hold one import specifier per line. It refuses `refused.stub`
 * outright and declares two Symbols under one id in `twins.stub`.
 */
const importsPerLine = stubLanguagePlugin({
  parseFile: async (file) => ({
    tree: {},
    errors: file.path.endsWith("/refused.stub")
      ? [{ message: "refused", line: 1, column: 1, recoverable: false }]
      : [],
    imports: file.content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((source, index) => ({ source, symbols: "*", line: index + 1, dynamic: false })),
  }),
  extractSymbols: (_tree, ctx) =>
    ctx.file.path.endsWith("/twins.stub") ? [twin(ctx.file.path, 3), twin(ctx.file.path, 9)] : [],
})

const WEB_SHARED_API = [
  component({ id: "web", name: "web", roots: ["web"] }),
  component({ id: "shared", name: "shared", roots: ["shared"] }),
  component({ id: "api", name: "api", roots: ["api"] }),
]

async function scanImports(
  files: Record<string, string>,
  extras: {
    components?: Component[]
    workspacePackages?: { name: string; root: string }[]
  } = {},
) {
  for (const [path, source] of Object.entries(files)) await workspace.writeSource(path, source)
  const logger = recordingLogger()
  const result = await scanStubs(workspace.root, {
    languages: [importsPerLine],
    components: extras.components ?? WEB_SHARED_API,
    workspacePackages: extras.workspacePackages ?? [
      { name: "@acme/shared", root: "shared" },
      { name: "@acme/api", root: "api" },
    ],
    logger,
  })
  return { ...result, warnings: logger.warnings }
}

describe("scan — Component edges", () => {
  it.each([
    ["refuses to parse it", "web/refused.stub", "parse-failed"],
    ["declares two Symbols under one id in it", "web/twins.stub", "extraction-failed"],
  ])("leave out the imports of a file the Document leaves out, as a plugin %s", async (_, withdrawn, reason) => {
    const { ir, skipped } = await scanImports({
      "web/good.stub": "@acme/shared\n",
      [withdrawn]: "@acme/api\n",
    })

    expect(skipped.map((file) => [file.path, file.reason])).toEqual([[withdrawn, reason]])
    expect(ir.dependencies).toEqual([dependency({ from: "web", to: "shared" })])
  })

  it.each([
    ["the workspace root directory", "../.."],
    ["a module at the top of the workspace", "../../index"],
  ])("reach the Component rooted at the workspace root through %s", async (_, specifier) => {
    const { ir } = await scanImports(
      { "web/src/app.stub": `${specifier}\n` },
      { components: [...WEB_SHARED_API, component({ id: "root", name: "root", roots: ["."] })] },
    )

    expect(ir.dependencies).toEqual([dependency({ from: "web", to: "root" })])
  })

  it("warn once for a package name the manifests of two Components declare, and draw no edge for it", async () => {
    const { ir, warnings } = await scanImports(
      { "web/a.stub": "@acme/common\n", "web/b.stub": "@acme/common/format\n@acme/api\n" },
      {
        workspacePackages: [
          { name: "@acme/common", root: "shared" },
          { name: "@acme/common", root: "api" },
          { name: "@acme/api", root: "api" },
        ],
      },
    )

    expect(ir.dependencies).toEqual([dependency({ from: "web", to: "api" })])
    expect(warnings).toEqual([
      "@acme/common names a package in each of the Components api, shared, so an import of it draws no Component edge.",
    ])
  })
})
