import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { COMPONENTS_DIRNAME, EXIT, runScan } from "../src"
import { TYPESCRIPT, writeConfig, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("component-md")

describe("out/components/<id>.md", () => {
  it("lists the Symbols of the component whose root holds their file, and counts them", async () => {
    await writePackageJson(workspace.root)
    await workspace.writeSource(
      "packages/api/src/orders.ts",
      "export function submitOrder(total: number): number {\n  return total + 1\n}\n",
    )
    await workspace.writeSource(
      "packages/web/src/page.ts",
      'export function renderPage(total: number): string {\n  return "" + total\n}\n',
    )
    await writeConfig(workspace.root, {
      ...TYPESCRIPT,
      components: [
        { id: "api", roots: ["packages/api"], languages: ["ts"] },
        { id: "web", roots: ["packages/web"], languages: ["ts"] },
      ],
    })

    const report = await runScan({ cwd: workspace.root, format: "both" })

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    const page = (id: string) =>
      readFile(resolve(workspace.root, "out", COMPONENTS_DIRNAME, `${id}.md`), "utf8")
    const api = await page("api")
    expect(api).toContain("# Component: api")
    expect(api).toMatch(/\*\*Symbols\*\*: [1-9]\d* kept/)
    expect(api).toContain("## Symbols")
    expect(api).toContain("packages/api/src/orders.ts")
    expect(api).toContain("submitOrder")
    expect(api).not.toContain("packages/web/")
    const web = await page("web")
    expect(web).toContain("packages/web/src/page.ts")
    expect(web).not.toContain("packages/api/")
  })
})
