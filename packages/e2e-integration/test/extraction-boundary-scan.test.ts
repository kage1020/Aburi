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
 * `export const { GET, POST } = handlers` — an Auth.js route file — hands `makeSymbolId` the
 * text of an `object_pattern` as a qualified name, and the id grammar refuses it. That is a
 * `CoreError`, thrown from inside `extractSymbols`, and it is the shape that makes the
 * boundary worth having: the source is legal TypeScript, the plugin is the real one, and the
 * throw is a property of that one file. Without a boundary it costs the whole workspace.
 *
 * The IR the surviving files produce still goes through `assertIRIntegrity`, so what comes
 * out of a run with a withdrawn file is a document and not a fragment.
 */

const BAD_SOURCE = [
  "const handlers = { GET: 1, POST: 2 }",
  "export const { GET, POST } = handlers",
  "",
].join("\n")

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
      { file: "src/route.ts", message: expect.stringContaining("{ GET, POST }") },
    ])
    expect(result.skipped).toEqual([
      {
        path: "src/route.ts",
        reason: "extraction-failed",
        detail: expect.stringContaining("{ GET, POST }"),
      },
    ])
  })

  it("counts the withdrawn file out of parsedFiles and into totalFiles", async () => {
    const result = await scanWorkspace()
    expect(result.ir.stats.totalFiles).toBe(3)
    expect(result.ir.stats.parsedFiles).toBe(2)
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
