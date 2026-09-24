import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith, symbolNamed } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * What the file's imports say about a decorator, all the way through `scan()`.
 *
 * The unit tests hand the classifier an import list built by hand. This one makes the
 * language plugin produce it, and then makes the core fold the answer back onto the Symbol —
 * which is where the classification's two halves have to agree on which name is which. The
 * tables are matched on the name a decorator was imported under, while the boundary flags
 * come back keyed on the name the source wrote; get that backwards and every extKind is
 * still right while every `Decorator.boundary` silently stays false.
 */

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
    // The same source without its import line. Nothing says what `Ctrl` is, so the written
    // name stands and matches nothing — the alias above was recognized because the file
    // said what it was, not because `Ctrl` is vocabulary.
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
    // `Decorator.qualifier` carries the receiver, and the framework resolves it against the
    // edge's `namespaceBinding`. The boundary flags still come back on the leaf name, which
    // is what `Decorator.name` holds.
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
    // `@(Controller)` and `@(nest\n  .Controller)` are legal and parse cleanly. Read as their
    // text, they were named `(Controller)` and `(nest\n  .Controller)`, matched no table, and
    // left the class unclassified with a line break in `Decorator.name`.
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
    // `@tsed.Controller()` used to be indistinguishable from `@nest.Controller()` — the
    // qualifier was thrown away, so both arrived as the leaf `Controller` with nothing
    // naming a module, and both came back `high`.
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
    // `import tsed from "@tsed/common"` binds the module object through the named-import
    // index instead — the language plugin reports it as `symbols: ["tsed"]`. A plugin
    // reading only namespace edges leaves this file in the most-trusting tier.
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
