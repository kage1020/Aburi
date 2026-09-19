import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith, symbolNamed } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * Where a decorator is written must not change what the Symbol is classified as. `@Controller`
 * on the far side of `export` is the case that makes this visible: read it and the class is a
 * controller, miss it and the IR carries framework routes under an owner with no boundary.
 * Two decorators sharing a line is the other: `classifyClass` takes the first in source order,
 * so an order that does not survive extraction is a different `extKind`.
 *
 * This is the whole chain — parse, extract, classify — not `readDecorators` in isolation.
 */

const workspace = useScratchWorkspace("decorator-placement")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })

describe("scan — decorator placement through @aburi/framework-nestjs", () => {
  it("classifies a controller decorated after the `export` keyword", async () => {
    await workspace.writeSource(
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

    const result = await scanWorkspace()
    expect(symbolNamed(result, "AController").extKind).toBe("framework:nestjs:controller")
    expect(symbolNamed(result, "AController.list").extKind).toBe("framework:nestjs:route")
  })

  it("takes the first class-level decorator in source order when two share a line", async () => {
    // Two on one line have no line number to separate them, so the extracted order is the
    // whole of the contract; getting it wrong is a different `extKind` at `confidence: "high"`.
    await workspace.writeSource(
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

    const result = await scanWorkspace()
    expect(symbolNamed(result, "BFilter").extKind).toBe("framework:nestjs:provider")
  })

  it("gives the same classification whether the decorators share a line or not", async () => {
    await workspace.writeSource(
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

    const result = await scanWorkspace()
    expect(symbolNamed(result, "B2Filter").extKind).toBe("framework:nestjs:provider")
  })

  it("reads a route's decorators in source order past the `export` keyword", async () => {
    await workspace.writeSource(
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

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "CController")
    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.decorators.map((d) => d.name)).toEqual(["UseGuards", "Controller"])
  })

  it("classifies an injectable that is not exported at all", async () => {
    await workspace.writeSource(
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

    const result = await scanWorkspace()
    expect(symbolNamed(result, "CService").extKind).toBe("framework:nestjs:provider")
  })
})
