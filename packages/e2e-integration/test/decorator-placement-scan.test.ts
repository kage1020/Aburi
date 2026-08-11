import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { scan } from "@aburi/core"
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { IRSymbol } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * The symptom that made the decorator-placement gap worth fixing: `@Controller` written on
 * the far side of `export` left the class unclassified, so the IR carried framework routes
 * under an owner with no boundary. This is the whole chain — parse, extract, classify — not
 * `readDecorators` in isolation.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-decorator-placement-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function writeSource(rel: string, content: string): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

async function scanWorkspace(): Promise<readonly IRSymbol[]> {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(nestjsFrameworkPlugin.manifest)
  const result = await scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
    effects: [],
    registry,
    components: [],
  })
  return result.ir.symbols
}

function byName(symbols: readonly IRSymbol[], name: string): IRSymbol {
  const match = symbols.find((s) => s.name === name)
  if (match === undefined) {
    throw new Error(`no symbol named "${name}" (have: ${symbols.map((s) => s.name).join(", ")})`)
  }
  return match
}

describe("scan — decorator placement through @aburi/framework-nestjs", () => {
  it("classifies a controller decorated after the `export` keyword", async () => {
    await writeSource(
      "src/a.controller.ts",
      [
        `import { Controller, Get } from "@nestjs/common"`,
        ``,
        `export @Controller("a") class AController {`,
        `  @Get()`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const symbols = await scanWorkspace()
    expect(byName(symbols, "AController").extKind).toBe("framework:nestjs:controller")
    expect(byName(symbols, "AController.list").extKind).toBe("framework:nestjs:route")
  })

  it("classifies one decorated before the keyword the same way", async () => {
    await writeSource(
      "src/b.controller.ts",
      [
        `import { Controller, Get } from "@nestjs/common"`,
        ``,
        `@Controller("b")`,
        `export class BController {`,
        `  @Get()`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const symbols = await scanWorkspace()
    expect(byName(symbols, "BController").extKind).toBe("framework:nestjs:controller")
  })

  it("classifies an injectable that is not exported at all", async () => {
    await writeSource(
      "src/c.service.ts",
      [
        `import { Injectable } from "@nestjs/common"`,
        ``,
        `@Injectable()`,
        `class CService {`,
        `  find() { return null }`,
        `}`,
        ``,
        `export { CService }`,
        ``,
      ].join("\n"),
    )

    const symbols = await scanWorkspace()
    expect(byName(symbols, "CService").extKind).toBe("framework:nestjs:provider")
  })
})
