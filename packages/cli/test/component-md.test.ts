import { readdir, readFile, writeFile } from "node:fs/promises"
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

describe("out/components/ after Components are renamed or removed", () => {
  const inComponents = (name: string) => resolve(workspace.root, "out", COMPONENTS_DIRNAME, name)
  const pages = async () => (await readdir(inComponents("."))).sort()

  async function scanDeclaring(rootById: Record<string, string>): Promise<void> {
    await writePackageJson(workspace.root)
    for (const root of Object.values(rootById)) {
      await workspace.writeSource(`${root}/src/index.ts`, "export const value = 1\n")
    }
    await writeConfig(workspace.root, {
      ...TYPESCRIPT,
      components: Object.entries(rootById).map(([id, root]) => ({
        id,
        roots: [root],
        languages: ["ts"],
      })),
    })
    expect((await runScan({ cwd: workspace.root, format: "both" })).exitCode).toBe(EXIT.SUCCESS)
  }

  const BEFORE = { alpha: "packages/alpha", beta: "packages/beta", delta: "packages/delta" }
  const AFTER = { alpha: "packages/alpha", gamma: "packages/beta" }

  it.each([
    ["as the scan wrote them", (page: string) => page],
    [
      "with CRLF line endings, as a Windows checkout has them",
      (page: string) => page.replaceAll("\n", "\r\n"),
    ],
  ])("removes the page of every id the IR no longer holds, %s", async (_, checkout) => {
    await scanDeclaring(BEFORE)
    for (const stale of ["beta.md", "delta.md"]) {
      await writeFile(inComponents(stale), checkout(await readFile(inComponents(stale), "utf8")))
    }

    await scanDeclaring(AFTER)

    expect(await pages()).toEqual(["alpha.md", "gamma.md"])
  })

  it.each([
    ["a file that is not Markdown", "beta.txt", "# Component: beta\n"],
    ["Markdown that opens with another heading", "index.md", "# Components\n\nSee the pages.\n"],
    ["a page whose heading names another Component", "beta-notes.md", "# Component: beta\n"],
    ["a page whose heading continues past the id", "delta.md", "# Component: delta (archived)\n"],
    ["a page under a name no Component id takes", "Billing.md", "# Component: Billing\n"],
    ["a page in a subdirectory", "archive/beta.md", "# Component: beta\n"],
    ["a directory named like a page", "zeta.md/notes.md", "# Component: zeta\n"],
  ])("keeps %s beside the pages", async (_, name, contents) => {
    await scanDeclaring(BEFORE)
    await workspace.writeSource(`out/${COMPONENTS_DIRNAME}/${name}`, contents)

    await scanDeclaring(AFTER)

    expect(await readFile(inComponents(name), "utf8")).toBe(contents)
    expect(await pages()).toEqual(["alpha.md", "gamma.md", name.split("/")[0]].sort())
  })
})
