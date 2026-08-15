import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type ScanResult, scan } from "@aburi/core"
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * One `import x from ""` must not end the run.
 *
 * `ImportEdge.source` is contractually non-empty, and the guards a plugin uses to read the
 * edge list throw when it is not. So an edge carrying an empty specifier turns syntax a user
 * can legally write into an exception raised inside a classifier — which no part of the scan
 * catches, taking every other file's Symbols down with the offending one's.
 *
 * A decorator-driven framework plugin walks the edge list for every file holding a decorated
 * class or method, which is why the fixture below is a controller: it is the cheapest shape
 * that reaches the guard.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-empty-specifier-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function writeSource(rel: string, content: string): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

async function scanWorkspace(): Promise<ScanResult> {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(nestjsFrameworkPlugin.manifest)
  return scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
    effects: [],
    registry,
    components: [],
  })
}

describe("scan — a file with an empty module specifier", () => {
  beforeEach(async () => {
    await writeSource(
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
    await writeSource(
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
    const names = result.ir.symbols.map((s) => s.name)
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
    // Reporting and withdrawing are separate outcomes, and the file having Symbols in the
    // previous case is what shows this one did not withdraw it. `skipped` cannot show it:
    // its four reasons are all discovery-side or budget-side, and a file whose parse
    // returned no tree is counted rather than listed.
    expect(result.ir.symbols.some((s) => s.source.file === "src/a.controller.ts")).toBe(true)
  })

  it("still resolves the decorators the surviving edges describe", async () => {
    const result = await scanWorkspace()
    const controller = result.ir.symbols.find((s) => s.name === "AController")
    expect(controller?.extKind).toBe("framework:nestjs:controller")
    expect(controller?.confidence).toBe("high")
  })
})
