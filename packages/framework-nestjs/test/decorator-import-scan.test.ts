import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nestjsFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("decorator-import")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })

/** The source below, parameterized on the import line that supplies its two decorators. */
function controllerSource(importLine: string | null): string {
  return [
    ...(importLine === null ? [] : [importLine, ``]),
    `@Ctrl("/d")`,
    `export class DController {`,
    `  @Fetch("/list")`,
    `  list() { return [] }`,
    `}`,
    ``,
  ].join("\n")
}

describe("scan — decorator provenance through @aburi/framework-nestjs", () => {
  it("classifies decorators renamed on import, and flags them on the Symbol", async () => {
    await workspace.writeSource(
      "src/d.controller.ts",
      controllerSource(`import { Controller as Ctrl, Get as Fetch } from "@nestjs/common"`),
    )

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "DController")
    const route = symbolNamed(result, "DController.list")

    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(route.extKind).toBe("framework:nestjs:route")
    expect(controller.decorators.map((d) => [d.name, d.boundary])).toEqual([["Ctrl", true]])
    expect(route.decorators.map((d) => [d.name, d.boundary])).toEqual([["Fetch", true]])
    expect(route.derivedBy).toContain("framework:nestjs:route:Get")
    expect(controller.confidence).toBe("high")
  })

  it("takes the written name when nothing in the file binds it", async () => {
    await workspace.writeSource("src/d2.controller.ts", controllerSource(null))

    const result = await scanWorkspace()
    expect(symbolNamed(result, "DController").extKind).toBeNull()
    expect(symbolNamed(result, "DController.list").extKind).toBeNull()
  })

  it("still classifies vocabulary written under its own name with no import at all", async () => {
    await workspace.writeSource(
      "src/d4.controller.ts",
      [
        `@Controller("/d4")`,
        `export class D4Controller {`,
        `  @Get("/list")`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    expect(symbolNamed(result, "D4Controller").extKind).toBe("framework:nestjs:controller")
    expect(symbolNamed(result, "D4Controller.list").extKind).toBe("framework:nestjs:route")
    expect(symbolNamed(result, "D4Controller").confidence).toBe("high")
  })

  it("ties a namespace-imported decorator back to the module it was written through", async () => {
    await workspace.writeSource(
      "src/d5.controller.ts",
      [
        `import * as nest from "@nestjs/common"`,
        ``,
        `@nest.Controller("/d5")`,
        `export class D5Controller {`,
        `  @nest.Get("/list")`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "D5Controller")
    const route = symbolNamed(result, "D5Controller.list")

    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.confidence).toBe("high")
    expect(controller.decorators.map((d) => [d.name, d.qualifier, d.boundary])).toEqual([
      ["Controller", "nest", true],
    ])
    expect(route.extKind).toBe("framework:nestjs:route")
    expect(route.derivedBy).toContain("framework:nestjs:route:Get")
  })

  it("classifies a decorator written in parentheses as the one it encloses", async () => {
    await workspace.writeSource(
      "src/d6.controller.ts",
      [
        `import { Controller } from "@nestjs/common"`,
        `import * as nest from "@nestjs/common"`,
        ``,
        `@(Controller)`,
        `export class D6Controller {}`,
        ``,
        `@(nest`,
        `  .Controller)`,
        `export class D7Controller {}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const bare = symbolNamed(result, "D6Controller")
    const qualified = symbolNamed(result, "D7Controller")

    expect(bare.extKind).toBe("framework:nestjs:controller")
    expect(bare.decorators.map((d) => [d.name, d.qualifier, d.boundary])).toEqual([
      ["Controller", undefined, true],
    ])
    expect(qualified.extKind).toBe("framework:nestjs:controller")
    expect(qualified.decorators.map((d) => [d.name, d.qualifier, d.boundary])).toEqual([
      ["Controller", "nest", true],
    ])
  })

  it("says it is less sure about a namespace import from a competing library", async () => {
    await workspace.writeSource(
      "src/d6.controller.ts",
      [
        `import * as tsed from "@tsed/common"`,
        ``,
        `@tsed.Controller("/d6")`,
        `export class D6Controller {`,
        `  find() { return null }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "D6Controller")
    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.confidence).toBe("medium")
  })

  it("reads a receiver bound by a default import, not only a namespace one", async () => {
    await workspace.writeSource(
      "src/d7.controller.ts",
      [
        `import tsed from "@tsed/common"`,
        ``,
        `@tsed.Controller("/d7")`,
        `export class D7Controller {}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "D7Controller")
    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.confidence).toBe("medium")
  })

  it("classifies a decorator from a competing library, but says it is less sure", async () => {
    await workspace.writeSource(
      "src/d3.controller.ts",
      [
        `import { Controller } from "routing-controllers"`,
        ``,
        `@Controller("/d3")`,
        `export class D3Controller {`,
        `  find() { return null }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "D3Controller")
    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.confidence).toBe("medium")
  })
})
