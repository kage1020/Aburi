import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runScan } from "../src"

/**
 * `out/components/<id>.md` read back off disk, which is the artefact a reviewer opens.
 *
 * The file was four header lines and nothing else for every workspace, because every Symbol
 * carried `component: null` and the writer's filter (`s.component === component.id`) matched
 * none of them. Nothing here was covered: the projection layer's own tests hand
 * `projectComponent` a pre-filtered list, so they pass on a document the filter would empty.
 */

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-component-md-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "component-md-fixture", private: true }),
    "utf8",
  )
  await writeSource(
    "packages/api/src/orders.ts",
    ["export function submitOrder(total: number): number {", "  return total + 1", "}", ""].join(
      "\n",
    ),
  )
  await writeSource(
    "packages/web/src/page.ts",
    ["export function renderPage(total: number): string {", '  return "" + total', "}", ""].join(
      "\n",
    ),
  )
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function writeSource(rel: string, content: string): Promise<void> {
  const abs = resolve(scratch, rel)
  await mkdir(resolve(abs, ".."), { recursive: true })
  await writeFile(abs, content, "utf8")
}

/** Scan the fixture with two config-declared components and return the written Markdown. */
async function scanTwoComponents(): Promise<{ api: string; web: string }> {
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      components: [
        { id: "api", roots: ["packages/api"], languages: ["ts"] },
        { id: "web", roots: ["packages/web"], languages: ["ts"] },
      ],
    }),
    "utf8",
  )
  const report = await runScan({
    cwd: scratch,
    outputDir: resolve(scratch, "out"),
    format: "both",
  })
  expect(report.exitCode).toBe(0)
  const read = async (id: string): Promise<string> =>
    readFile(resolve(scratch, "out", "components", `${id}.md`), "utf8")
  return { api: await read("api"), web: await read("web") }
}

describe("out/components/<id>.md", () => {
  it("lists the Symbols of the component whose root holds their file", async () => {
    const { api, web } = await scanTwoComponents()

    expect(api).toContain("# Component: api")
    expect(api).toContain("## Symbols")
    expect(api).toContain("packages/api/src/orders.ts")
    expect(api).toContain("submitOrder")
    // The other component's file belongs to the other page, which is the half of the
    // attribution rule a single-component workspace cannot show.
    expect(api).not.toContain("packages/web/")

    expect(web).toContain("## Symbols")
    expect(web).toContain("packages/web/src/page.ts")
    expect(web).not.toContain("packages/api/")
  })

  it("counts the component's Symbols in its header instead of reporting zero", async () => {
    const { api } = await scanTwoComponents()

    expect(api).toMatch(/\*\*Symbols\*\*: [1-9]\d* kept/)
  })
})
