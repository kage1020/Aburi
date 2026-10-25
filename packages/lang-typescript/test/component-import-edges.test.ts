import { component, dependency, useScratchWorkspace } from "@aburi/test-support"
import type { Dependency } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { scanTypeScript } from "./fixtures/scan"

const workspace = useScratchWorkspace("component-import-edges")

const COMPONENTS = [
  component({ id: "web", name: "@acme/web", roots: ["packages/web"] }),
  component({ id: "shared", name: "@acme/shared", roots: ["packages/shared"] }),
  component({ id: "api", name: "@acme/api", roots: ["packages/api"] }),
]

const PACKAGES = [
  { name: "@acme/web", root: "packages/web" },
  { name: "@acme/shared", root: "packages/shared" },
  { name: "@acme/api", root: "packages/api" },
]

const WEB_TO_SHARED = dependency({ from: "web", to: "shared" })

async function componentEdges(
  files: Record<string, string>,
  packages = PACKAGES,
): Promise<{ edges: Dependency[]; dependencies: Dependency[] }> {
  await workspace.writeSource("packages/shared/src/format.ts", "export const format = String\n")
  for (const [path, source] of Object.entries(files)) await workspace.writeSource(path, source)
  const { ir } = await scanTypeScript(
    workspace.root,
    {},
    { components: COMPONENTS, workspacePackages: packages },
  )
  return {
    edges: ir.dependencies.filter((edge) => edge.via === "import"),
    dependencies: ir.dependencies,
  }
}

describe("scan — a Component edge per import that crosses a Component boundary", () => {
  it.each<[string, string, Dependency[]]>([
    [
      "a relative path into another Component",
      'import { format } from "../../shared/src/format"',
      [WEB_TO_SHARED],
    ],
    ["a workspace package by name", 'import { format } from "@acme/shared"', [WEB_TO_SHARED]],
    [
      "a subpath of a workspace package",
      'import { format } from "@acme/shared/src/format"',
      [WEB_TO_SHARED],
    ],
    ["a type-only import", 'import type { Format } from "@acme/shared"', [WEB_TO_SHARED]],
    ["a re-export", 'export { format } from "@acme/shared"', [WEB_TO_SHARED]],
    [
      "a dynamic import",
      'export async function load() {\n  return import("@acme/shared")\n}',
      [WEB_TO_SHARED],
    ],
    [
      "a module the scan does not read",
      'import tokens from "../../shared/tokens.json"',
      [WEB_TO_SHARED],
    ],
    ["the importing Component's own package", 'import { page } from "@acme/web"', []],
    ["a path inside the importing Component", 'import { page } from "./page"', []],
    ["a package from outside the workspace", 'import { debounce } from "lodash"', []],
    ["a scoped name no workspace package has", 'import { x } from "@acme/unknown"', []],
    ["a Node built-in", 'import { readFile } from "node:fs/promises"', []],
    ["a path that climbs out of the workspace", 'import { x } from "../../../../outside"', []],
  ])("%s", async (_, source, expected) => {
    const { edges } = await componentEdges({ "packages/web/src/app.ts": `${source}\n` })
    expect(edges).toEqual(expected)
  })

  it("writes one edge however many imports and files cross the same boundary", async () => {
    const { edges } = await componentEdges({
      "packages/web/src/a.ts":
        'import { format } from "@acme/shared"\nimport "../../shared/src/format"\n',
      "packages/web/src/b.ts": 'import { format } from "@acme/shared/src/format"\n',
      "packages/api/src/c.ts": 'import { format } from "@acme/shared"\n',
    })
    expect(edges).toEqual([dependency({ from: "api", to: "shared" }), WEB_TO_SHARED])
  })

  it("writes none for a file that belongs to no Component", async () => {
    const { edges } = await componentEdges({
      "scripts/build.ts": 'import { format } from "@acme/shared"\n',
    })
    expect(edges).toEqual([])
  })

  it("reads a package name two Components both claim as naming neither", async () => {
    const { edges } = await componentEdges(
      { "packages/web/src/app.ts": 'import { format } from "@acme/common"\n' },
      [
        { name: "@acme/common", root: "packages/shared" },
        { name: "@acme/common", root: "packages/api" },
      ],
    )
    expect(edges).toEqual([])
  })

  it("adds nothing for a resolved call into another Component beside the import it went through", async () => {
    const { dependencies } = await componentEdges({
      "packages/web/src/app.ts": [
        'import { format } from "../../shared/src/format"',
        "export function render() {",
        "  return format(1)",
        "}",
        "",
      ].join("\n"),
    })
    expect(dependencies).toEqual([
      dependency({
        from: "ts:packages/web/src/app.ts#render",
        to: "ts:packages/shared/src/format.ts#format",
        via: "call",
      }),
      WEB_TO_SHARED,
    ])
  })
})
