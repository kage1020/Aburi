import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith, symbolNamed } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

const workspace = useScratchWorkspace("empty-specifier")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })

describe("scan — a file with an empty module specifier", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/a.controller.ts",
      [
        `import { Controller, Get } from "@nestjs/common"`,
        `import broken from ""`,
        ``,
        `@Controller("/a")`,
        `export class AController {`,
        `  @Get()`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/b.service.ts",
      [
        `import { Injectable } from "@nestjs/common"`,
        ``,
        `@Injectable()`,
        `export class BService {}`,
        ``,
      ].join("\n"),
    )
  })

  it("completes, and keeps both the offending file's Symbols and its neighbour's", async () => {
    const result = await scanWorkspace()
    const names = result.ir.symbols.map((symbol) => symbol.name)
    expect(names).toContain("AController")
    expect(names).toContain("AController.list")
    expect(names).toContain("BService")
  })

  it("reports the specifier through the incident channel rather than the exception path", async () => {
    const result = await scanWorkspace()
    const record = result.parseErrors.find((r) => r.file === "src/a.controller.ts")
    expect(record?.errors).toEqual([
      {
        message: expect.stringContaining("empty module specifier"),
        line: 2,
        column: 20,
        recoverable: true,
      },
    ])
    expect(result.ir.symbols.some((s) => s.source.file === "src/a.controller.ts")).toBe(true)
  })

  it("still resolves the decorators the surviving edges describe", async () => {
    const result = await scanWorkspace()
    const controller = symbolNamed(result, "AController")
    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.confidence).toBe("high")
  })
})
