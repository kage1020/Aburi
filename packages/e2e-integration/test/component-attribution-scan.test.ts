import { makeComponentId, makeLanguageId } from "@aburi/core"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { projectComponent, projectWorkspace } from "@aburi/markdown-projection"
import type { Component } from "@aburi/types"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

const API: Component = {
  id: makeComponentId("api"),
  name: "@acme/api",
  roots: ["packages/api"],
  languages: [makeLanguageId("ts")],
  description: null,
}

const WEB: Component = {
  id: makeComponentId("web"),
  name: "@acme/web",
  roots: ["packages/web"],
  languages: [makeLanguageId("ts")],
  description: null,
}

const workspace = useScratchWorkspace("attribution-e2e")

beforeEach(async () => {
  await workspace.writeSource(
    "packages/api/src/invoice.service.ts",
    [
      'import { PrismaClient } from "@prisma/client"',
      "",
      "export class InvoiceService {",
      "  constructor(private readonly prisma: PrismaClient) {}",
      "",
      "  async issue(data: unknown) {",
      "    return this.prisma.invoice.create({ data })",
      "  }",
      "}",
      "",
    ].join("\n"),
  )
  await workspace.writeSource(
    "packages/web/src/invoice-page.ts",
    [
      "export function renderInvoicePage(total: number): string {",
      '  return "Total: " + String(total)',
      "}",
      "",
    ].join("\n"),
  )
})

const scanWorkspace = () =>
  scanWith(
    workspace.root,
    { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] },
    {},
    { components: [API, WEB] },
  )

describe("e2e: a scanned two-package workspace fills its per-component views", () => {
  it("counts each component's Symbols in workspace.md instead of reporting zero", async () => {
    const { ir } = await scanWorkspace()

    const kept = ir.symbols.filter((symbol) => !symbol.dropped)
    const inApi = kept.filter((symbol) => symbol.component === "api")
    const inWeb = kept.filter((symbol) => symbol.component === "web")
    expect(inApi.length).toBeGreaterThan(0)
    expect(inWeb.length).toBeGreaterThan(0)
    expect(inApi.length + inWeb.length).toBe(kept.length)

    const md = projectWorkspace(ir, { suppressTimestamp: true })
    expect(md).toContain(`| api | \`packages/api\` | ts | — | ${inApi.length} |`)
    expect(md).toContain(`| web | \`packages/web\` | ts | — | ${inWeb.length} |`)
  })

  it("names the component an effect was found in, in the effect-surface table", async () => {
    const { ir } = await scanWorkspace()

    const md = projectWorkspace(ir, { suppressTimestamp: true })
    const dbWrite = md.split("\n").find((line) => line.startsWith("| db.write |"))
    expect(dbWrite).toMatch(/^\| db\.write \| \d+ \| api \|$/)
  })

  it("gives components/<id>.md the Symbols the component holds", async () => {
    const { ir } = await scanWorkspace()

    const md = projectComponent({
      component: API,
      symbols: ir.symbols.filter((symbol) => symbol.component === API.id),
      dependencies: ir.dependencies,
    })

    expect(md).toContain("## Symbols")
    expect(md).toContain("packages/api/src/invoice.service.ts")
    expect(md).not.toContain("packages/web/")
  })
})
