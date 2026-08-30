import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { assertIRIntegrity, type ScanResult, scan } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * The per-file exception boundary, reached the way a user reaches it: with the real
 * TypeScript plugin and a source file it cannot express.
 *
 * `export const a🙂 = 1` hands `makeSymbolId` a qualified name carrying a character
 * ECMAScript's IdentifierName does not admit, and the id grammar refuses it. That is a
 * `CoreError`, thrown from inside `extractSymbols`, and it is the shape that makes the
 * boundary worth having: tree-sitter parses the name without complaint, the plugin is the
 * real one, and the throw is a property of that one file. Without a boundary it costs the
 * whole workspace.
 *
 * The fixture used to be `export const { GET, POST } = handlers`, which extraction reads as
 * two bindings now rather than as one unusable name. What this file needs is any construct
 * the id grammar refuses; an emoji is one no widening will make legal, because `tsc` does not
 * accept it either.
 *
 * The IR the surviving files produce still goes through `assertIRIntegrity`, so what comes
 * out of a run with a withdrawn file is a document and not a fragment.
 */

const BAD_SOURCE = ["export const a\u{1F642} = 1", ""].join("\n")

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-extraction-boundary-"))
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
  return scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [langTypescriptPlugin],
    frameworks: [],
    effects: [],
    registry,
    components: [],
  })
}

describe("scan — a file the id grammar cannot express", () => {
  beforeEach(async () => {
    await writeSource("src/route.ts", BAD_SOURCE)
    await writeSource("src/ok.ts", "export function ok() {\n  return 1\n}\n")
    await writeSource("src/also-ok.ts", "export class Also {\n  run() {}\n}\n")
  })

  it("finishes, and the files around it are in the IR", async () => {
    const result = await scanWorkspace()
    const names = result.ir.symbols.map((s) => s.name)
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
        // The code separates "this source is something the plugins cannot express" from "a
        // plugin crashed" without matching on prose.
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
    // The state the boundary newly creates: a partial IR that still contains references to
    // a file no longer in it. Everything that reads those references — LSP enrichment, call
    // resolution, dependency projection, the integrity check — runs *outside* the per-file
    // boundary, so a throw there would take the whole run down after all.
    await writeSource("src/route.ts", BAD_SOURCE)
    await writeSource(
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
    expect(result.ir.symbols.map((s) => s.name)).toEqual(["run"])
    expect(() => assertIRIntegrity(result.ir)).not.toThrow()
    // No edge may point at a Symbol the document does not contain.
    const ids = new Set(result.ir.symbols.map((s) => s.id))
    for (const dependency of result.ir.dependencies) {
      expect(ids.has(dependency.to as (typeof result.ir.symbols)[number]["id"])).toBe(true)
    }
    // The call is reported as unresolved rather than silently dropped.
    expect(result.unresolvedCalls.map((c) => [c.target, c.bucket])).toEqual([["GET", "no-match"]])
  })
})

describe("scan — a workspace with nothing wrong with it", () => {
  it("reports no extraction failures", async () => {
    await writeSource("src/ok.ts", "export function ok() {\n  return 1\n}\n")
    const result = await scanWorkspace()
    expect(result.extractionFailures).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.ir.symbols.map((s) => s.name)).toEqual(["ok"])
  })
})
