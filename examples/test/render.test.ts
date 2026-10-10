import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { renderExample } from "../src/render"

const workspace = useScratchWorkspace("showcase")

const LANGUAGES = { languages: ["@aburi/lang-typescript"] }
const CONFIG = `${JSON.stringify(LANGUAGES, null, 2)}\n`

async function writeExample(files: {
  readme?: string
  config?: string
  before: Record<string, string>
  after: Record<string, string>
}): Promise<string> {
  await workspace.writeSource(
    "example/README.md",
    files.readme ?? "# Guard removed\n\nThe price check stops refusing negative totals.\n",
  )
  await workspace.writeSource("example/aburi.json", files.config ?? CONFIG)
  for (const [path, content] of Object.entries(files.before)) {
    await workspace.writeSource(`example/before/${path}`, content)
  }
  for (const [path, content] of Object.entries(files.after)) {
    await workspace.writeSource(`example/after/${path}`, content)
  }
  return `${workspace.root}/example`
}

const GUARDED = [
  "export function price(total: number): number {",
  '  if (total < 0) throw new Error("negative total")',
  "  return total * 2",
  "}",
  "",
].join("\n")

const UNGUARDED = [
  "export function price(total: number): number {",
  "  return total * 2",
  "}",
  "",
].join("\n")

describe("renderExample", () => {
  it("opens the page with the README's title and narrative", async () => {
    const dir = await writeExample({
      before: { "src/price.ts": GUARDED },
      after: { "src/price.ts": UNGUARDED },
    })

    const showcase = await renderExample(dir)

    expect(showcase.title).toBe("Guard removed")
    expect(showcase.summary).toBe("The price check stops refusing negative totals.")
    expect(showcase.page.startsWith("# Guard removed\n\nThe price check stops refusing")).toBe(true)
  })

  it("shows the source change as a unified diff of every modified, added and removed file", async () => {
    const dir = await writeExample({
      before: { "src/price.ts": GUARDED, "src/old.ts": "export const old = 1\n" },
      after: { "src/price.ts": UNGUARDED, "src/new.ts": "export const fresh = 2\n" },
    })

    const { page } = await renderExample(dir)
    const change = page.slice(
      page.indexOf("```diff"),
      page.indexOf("```\n", page.indexOf("```diff")),
    )

    expect(change).toContain("--- a/src/price.ts\n+++ b/src/price.ts")
    expect(change).toContain('-  if (total < 0) throw new Error("negative total")')
    expect(change).toContain("+++ b/src/new.ts")
    expect(change).toContain("--- a/src/old.ts")
    expect(change).not.toContain("aburi.json")
  })

  it("embeds the report aburi diff prints, its headings nested under the page's", async () => {
    const dir = await writeExample({
      before: { "src/price.ts": GUARDED },
      after: { "src/price.ts": UNGUARDED },
    })

    const { page } = await renderExample(dir)

    expect(page).toContain("### Aburi diff: HEAD~1..HEAD")
    expect(page).toContain("guard: `total < 0`")
    expect(page).not.toMatch(/^# Aburi diff/m)
  })

  it("shows the aburi.json the example is scanned with", async () => {
    const dir = await writeExample({
      before: { "src/price.ts": GUARDED },
      after: { "src/price.ts": UNGUARDED },
    })

    const { page } = await renderExample(dir)

    expect(page).toContain(`\`\`\`json\n${CONFIG}\`\`\``)
  })

  it("refuses an example whose change the report does not see", async () => {
    const dir = await writeExample({
      before: { "src/price.ts": GUARDED },
      after: { "src/price.ts": GUARDED, "README.txt": "notes\n" },
    })

    await expect(renderExample(dir)).rejects.toThrow(/reports no change/)
  })

  it("refuses an example whose scans fell short, even when the report shows a change", async () => {
    const oversized = `export const table = ${JSON.stringify("x".repeat(2048))}
`
    const dir = await writeExample({
      config: JSON.stringify({ ...LANGUAGES, maxFileSizeBytes: 1024, minParsedFileRatio: 1 }),
      before: { "src/price.ts": GUARDED, "src/table.ts": oversized },
      after: { "src/price.ts": UNGUARDED, "src/table.ts": oversized },
    })

    await expect(renderExample(dir)).rejects.toThrow(/example: aburi diff exited 3/)
  })

  it("names the example in every refusal", async () => {
    const dir = await writeExample({
      before: { "src/price.ts": GUARDED },
      after: { "src/price.ts": GUARDED },
    })

    await expect(renderExample(dir)).rejects.toThrow(/^example: /)
  })

  it("renders the same page every time", async () => {
    const dir = await writeExample({
      before: { "src/price.ts": GUARDED },
      after: { "src/price.ts": UNGUARDED },
    })

    const first = await renderExample(dir)
    const second = await renderExample(dir)

    expect(second).toEqual(first)
    expect(first.page).not.toContain(workspace.root)
  })
})
