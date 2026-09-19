import { assertIRIntegrity } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * The per-file exception boundary, reached the way a user reaches it: with the real
 * TypeScript plugin and a source file it cannot express.
 *
 * `export const a🙂 = 1` hands `makeSymbolId` a qualified name carrying a character
 * ECMAScript's IdentifierName does not admit, and the id grammar refuses it. That is a
 * `CoreError` thrown from inside `extractSymbols`: tree-sitter parses the name without
 * complaint, the plugin is the real one, and the throw is a property of that one file.
 * Without a boundary it costs the whole workspace. An emoji is a construct no widening of
 * the grammar will make legal, because `tsc` does not accept it either.
 *
 * The IR the surviving files produce still goes through `assertIRIntegrity`, so what comes
 * out of a run with a withdrawn file is a document and not a fragment.
 */

const BAD_SOURCE = ["export const a\u{1F642} = 1", ""].join("\n")

const workspace = useScratchWorkspace("extraction-boundary")

const scanWorkspace = () => scanWith(workspace.root, { languages: [langTypescriptPlugin] })

describe("scan — a file the id grammar cannot express", () => {
  beforeEach(async () => {
    await workspace.writeSource("src/route.ts", BAD_SOURCE)
    await workspace.writeSource("src/ok.ts", "export function ok() {\n  return 1\n}\n")
    await workspace.writeSource("src/also-ok.ts", "export class Also {\n  run() {}\n}\n")
  })

  it("finishes, and the files around it are in the IR", async () => {
    const result = await scanWorkspace()
    const names = result.ir.symbols.map((symbol) => symbol.name)
    expect(names).toContain("ok")
    expect(names).toContain("Also")
    expect(result.ir.symbols.some((s) => s.source.file === "src/route.ts")).toBe(false)
  })

  it("produces a document that passes every integrity invariant", async () => {
    const result = await scanWorkspace()
    expect(() => assertIRIntegrity(result.ir)).not.toThrow()
  })

  it("names the file and what the plugin said about it", async () => {
    const result = await scanWorkspace()
    expect(result.extractionFailures).toEqual([
      {
        file: "src/route.ts",
        message: expect.stringContaining("a\u{1F642}"),
        // Separates "this source is something the plugins cannot express" from "a plugin
        // crashed" without matching on prose.
        code: "anonymous-symbol-id-attempted",
      },
    ])
    expect(result.skipped).toEqual([
      {
        path: "src/route.ts",
        reason: "extraction-failed",
        detail: expect.stringContaining("a\u{1F642}"),
      },
    ])
  })

  it("counts the withdrawn file out of parsedFiles and into totalFiles", async () => {
    const result = await scanWorkspace()
    expect(result.ir.stats.totalFiles).toBe(3)
    expect(result.ir.stats.parsedFiles).toBe(2)
  })
})

describe("scan — a surviving file that references the withdrawn one", () => {
  it("resolves what it can and leaves no dangling edge behind", async () => {
    // A partial IR still contains references to a file no longer in it. Everything that reads
    // those references — LSP enrichment, call resolution, dependency projection, the
    // integrity check — runs outside the per-file boundary, so a throw there would take the
    // whole run down after all.
    await workspace.writeSource("src/route.ts", BAD_SOURCE)
    await workspace.writeSource(
      "src/app.ts",
      [
        'import { GET } from "./route"',
        "",
        "export function run() {",
        "  return GET()",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()
    expect(result.ir.symbols.map((symbol) => symbol.name)).toEqual(["run"])
    expect(() => assertIRIntegrity(result.ir)).not.toThrow()
    // No edge may point at a Symbol the document does not contain.
    const ids = new Set(result.ir.symbols.map((symbol) => symbol.id))
    for (const dependency of result.ir.dependencies) {
      expect(ids.has(dependency.to as (typeof result.ir.symbols)[number]["id"])).toBe(true)
    }
    // The call is reported as unresolved rather than silently dropped.
    expect(result.unresolvedCalls.map((c) => [c.target, c.bucket])).toEqual([["GET", "no-match"]])
  })
})

describe("scan — a workspace with nothing wrong with it", () => {
  it("reports no extraction failures", async () => {
    await workspace.writeSource("src/ok.ts", "export function ok() {\n  return 1\n}\n")
    const result = await scanWorkspace()
    expect(result.extractionFailures).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.ir.symbols.map((symbol) => symbol.name)).toEqual(["ok"])
  })
})
