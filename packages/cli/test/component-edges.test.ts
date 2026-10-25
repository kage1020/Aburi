import { readFile } from "node:fs/promises"
import { dependency, errorFrom, useScratchWorkspace } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CliError, runScan } from "../src"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("component-edges")

async function writePackage(root: string, name: string, source: string): Promise<void> {
  await writePackageJson(`${workspace.root}/${root}`, { name, private: true })
  await writeFileAt(workspace.root, `${root}/src/index.ts`, source)
}

async function scan(config: Record<string, unknown> = {}) {
  await writeConfig(workspace.root, { ...TYPESCRIPT, ...config })
  const report = await runScan({ cwd: workspace.root, format: "both", outputDir: "out" })
  const ir = JSON.parse(await readFile(report.irPath ?? "", "utf8")) as IR
  const workspaceMd = await readFile(report.workspaceMdPath ?? "", "utf8")
  return { edges: ir.dependencies.filter((edge) => edge.via === "import"), workspaceMd }
}

describe("aburi scan — Component edges from imports between workspace packages", () => {
  it("draws the edge an import by package name makes, in the IR and in workspace.md", async () => {
    await writeFileAt(workspace.root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n")
    await writePackage("packages/web", "@acme/web", 'import { format } from "@acme/shared"\n')
    await writePackage("packages/shared", "@acme/shared", "export const format = String\n")

    const { edges, workspaceMd } = await scan()

    expect(edges).toEqual([dependency({ from: "acme-web", to: "acme-shared" })])
    expect(workspaceMd).toContain("  c_acme_web --> c_acme_shared\n")
    expect(workspaceMd).toContain("- `acme-web` → `acme-shared` (via `import`)\n")
  })

  it("reads the package name at a root the config declares", async () => {
    await writePackage("apps/web", "@acme/web", 'import { format } from "@acme/core"\n')
    await writePackage("libs/core", "@acme/core", "export const format = String\n")

    const { edges } = await scan({
      components: [
        { id: "web", roots: ["apps/web"] },
        { id: "core", roots: ["libs/core"] },
      ],
    })

    expect(edges).toEqual([dependency({ from: "web", to: "core" })])
  })

  it("finds a workspace package inside a declared Component that does not root it", async () => {
    await writeFileAt(workspace.root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n")
    await writePackage("apps/web", "@acme/web", 'import { Button } from "@acme/ui"\n')
    await writePackage("packages/ui", "@acme/ui", "export const Button = String\n")

    const { edges } = await scan({
      components: [
        { id: "web", roots: ["apps/web"] },
        { id: "platform", roots: ["packages"] },
      ],
    })

    expect(edges).toEqual([dependency({ from: "web", to: "platform" })])
  })

  it("refuses a package.json at a declared root that it cannot parse", async () => {
    await writeFileAt(workspace.root, "libs/core/package.json", "{ name: ")
    await writeConfig(workspace.root, {
      ...TYPESCRIPT,
      components: [{ id: "core", roots: ["libs/core"] }],
    })

    const error = await errorFrom(CliError, () => runScan({ cwd: workspace.root }))

    expect(error.code).toBe("config-error")
    expect(error.message).toMatch(
      /^Failed to resolve components: .*libs[/\\]core[/\\]package\.json/,
    )
  })
})
