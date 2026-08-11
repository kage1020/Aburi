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
 * Where a decorator is written must not change what the Symbol is classified as. `@Controller`
 * on the far side of `export` is the case that makes this visible: read it and the class is a
 * controller, miss it and the IR carries framework routes under an owner with no boundary.
 * Two decorators sharing a line is the other: `classifyClass` takes the first in source order,
 * so an order that does not survive extraction is a different `extKind`, not a cosmetic
 * difference.
 *
 * This is the whole chain — parse, extract, classify — not `readDecorators` in isolation.
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

  it("takes the first class-level decorator in source order when two share a line", async () => {
    // `classifyClass` resolves a class carrying several recognised decorators by taking the
    // first in source order. Two on one line have no line number to separate them, so the
    // extracted order is the whole of the contract, and getting it wrong here is not a
    // reordering — it is a different `extKind`, at `confidence: "high"`.
    await writeSource(
      "src/b.controller.ts",
      [
        `import { Controller, Injectable, Catch } from "@nestjs/common"`,
        ``,
        `@Injectable() @Catch(Error) class BFilter {}`,
        ``,
        `export { BFilter }`,
        ``,
      ].join("\n"),
    )

    const symbols = await scanWorkspace()
    expect(byName(symbols, "BFilter").extKind).toBe("framework:nestjs:provider")
  })

  it("gives the same classification whether the decorators share a line or not", async () => {
    await writeSource(
      "src/b2.controller.ts",
      [
        `import { Injectable, Catch } from "@nestjs/common"`,
        ``,
        `@Injectable()`,
        `@Catch(Error)`,
        `class B2Filter {}`,
        ``,
        `export { B2Filter }`,
        ``,
      ].join("\n"),
    )

    const symbols = await scanWorkspace()
    expect(byName(symbols, "B2Filter").extKind).toBe("framework:nestjs:provider")
  })

  it("reads a route's decorators in source order past the `export` keyword", async () => {
    await writeSource(
      "src/c.controller.ts",
      [
        `import { Controller, Get, UseGuards } from "@nestjs/common"`,
        ``,
        `export @UseGuards(AuthGuard) @Controller("c") class CController {`,
        `  @Get()`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const symbols = await scanWorkspace()
    const controller = byName(symbols, "CController")
    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.decorators.map((d) => d.name)).toEqual(["UseGuards", "Controller"])
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
