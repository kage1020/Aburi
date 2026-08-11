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
 * What the file's imports say about a decorator, all the way through `scan()`.
 *
 * The unit tests hand the classifier an import list built by hand. This one makes the
 * language plugin produce it, and then makes the core fold the answer back onto the Symbol —
 * which is where the classification's two halves have to agree on which name is which. The
 * tables are matched on the name a decorator was imported under, while the boundary flags
 * come back keyed on the name the source wrote; get that backwards and every extKind is
 * still right while every `Decorator.boundary` silently stays false.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-decorator-import-"))
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
    await writeSource(
      "src/d.controller.ts",
      controllerSource(`import { Controller as Ctrl, Get as Fetch } from "@nestjs/common"`),
    )

    const symbols = await scanWorkspace()
    const controller = byName(symbols, "DController")
    const route = byName(symbols, "DController.list")

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
    // said what it was, not because `Ctrl` is vocabulary. This is also the tier every
    // decorator falls into in a source that declares no imports at all.
    await writeSource("src/d2.controller.ts", controllerSource(null))

    const symbols = await scanWorkspace()
    expect(byName(symbols, "DController").extKind).toBeNull()
    expect(byName(symbols, "DController.list").extKind).toBeNull()
  })

  it("still classifies vocabulary written under its own name with no import at all", async () => {
    await writeSource(
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

    const symbols = await scanWorkspace()
    expect(byName(symbols, "D4Controller").extKind).toBe("framework:nestjs:controller")
    expect(byName(symbols, "D4Controller.list").extKind).toBe("framework:nestjs:route")
    expect(byName(symbols, "D4Controller").confidence).toBe("high")
  })

  it("classifies a decorator from a competing library, but says it is less sure", async () => {
    await writeSource(
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

    const symbols = await scanWorkspace()
    const controller = byName(symbols, "D3Controller")
    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.confidence).toBe("medium")
  })
})
