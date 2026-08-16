import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCli, runScan } from "../src"

class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

/**
 * A file the parse refused is reported as withdrawn, not as a file with warnings.
 *
 * No in-tree language plugin can produce this: `@aburi/lang-typescript` only emits
 * `recoverable: false` when its parser returned nothing, so the tree is null too and the
 * distinction never shows. The fixture therefore writes a language plugin into the
 * workspace and names it by relative path, which is a ref form the loader supports and
 * exactly how a third-party plugin would arrive.
 *
 * Four files, because the subject is a split and the counts have to be wrong separately:
 * `bad.stub` is refused, `notree.stub` comes back with no tree *and no errors*, `warn.stub`
 * carries a recoverable error and stays, `ok.stub` is clean.
 *
 * `notree.stub` is what separates the per-file filter from arithmetic. It is withdrawn but
 * contributes nothing to `parseErrors`, so `parseErrorCount = parseErrors.length -
 * parseFailureCount` would report one file too few while the filter reports the truth.
 */

const STUB_PLUGIN = `
const manifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "lang-stub",
  version: "0.0.0",
  type: "lang",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [],
    frameworks: [],
  },
}

export const plugin = {
  manifest,
  languageId: "stub",
  fileExtensions: [".stub"],
  capabilities: {
    hasDecorators: false,
    hasGenerics: false,
    hasAsync: false,
    hasMacros: false,
    hasPatternMatching: false,
    hasAbstractTypes: false,
    hasModules: false,
    hasNamespaces: false,
    hasTypeParameters: false,
    hasExplicitVisibility: false,
    hasJsDoc: false,
  },
  init: async () => {},
  parseFile: async (file) => {
    const tree = { path: file.path }
    if (file.path === "bad.stub") {
      return {
        tree,
        errors: [{ message: "unterminated string", line: 12, column: 4, recoverable: false }],
        imports: [],
      }
    }
    if (file.path === "warn.stub") {
      return {
        tree,
        errors: [{ message: "stray token", line: 2, column: 1, recoverable: true }],
        imports: [],
      }
    }
    if (file.path === "notree.stub") {
      return { tree: null, errors: [], imports: [] }
    }
    return { tree, errors: [], imports: [] }
  },
  extractSymbols: (tree, ctx) => {
    const name = ctx.file.path.replace(/[^A-Za-z0-9]/g, "_")
    return [
      {
        id: "stub:" + ctx.file.path + "#" + name,
        kind: "function",
        extKind: null,
        name,
        visibility: "public",
        decorators: [],
        signature: null,
        source: {
          file: ctx.file.path,
          startLine: 1,
          endLine: 2,
          startColumn: null,
          endColumn: null,
        },
        derivedBy: [],
        bodyNode: tree,
        fullNode: tree,
      },
    ]
  },
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "stub-ast",
}
`

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-parse-failure-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "parse-failure-fixture", private: true }),
    "utf8",
  )
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.dev/schema/aburi.config.v1.json",
      languages: ["./lang-stub.mjs"],
    }),
    "utf8",
  )
  await writeFile(resolve(scratch, "lang-stub.mjs"), STUB_PLUGIN, "utf8")
  await writeFile(resolve(scratch, "bad.stub"), "bad", "utf8")
  await writeFile(resolve(scratch, "notree.stub"), "notree", "utf8")
  await writeFile(resolve(scratch, "warn.stub"), "warn", "utf8")
  await writeFile(resolve(scratch, "ok.stub"), "ok", "utf8")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runScan — a file the language plugin refused", () => {
  async function report() {
    return runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" })
  }

  it("names both in skipped, and counts them apart from the file that kept its warnings", async () => {
    const scan = await report()
    expect(scan.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["bad.stub", "parse-failed"],
      ["notree.stub", "parse-failed"],
    ])
    expect(scan.parseFailureCount).toBe(2)
    // `warn.stub` and nothing else. `bad.stub`'s error is on `ScanResult.parseErrors` too —
    // it is the account of why the file went — but counting it here would call it
    // recoverable, which is the opposite of what it said. `notree.stub` contributes no
    // error at all, which is what makes this count a filter rather than a subtraction.
    expect(scan.parseErrorCount).toBe(1)
  })

  it("keeps the exit code at 0: an unparseable file describes the source", async () => {
    const scan = await report()
    expect(scan.exitCode).toBe(0)
    expect(scan.extractionFailures).toEqual([])
    expect(scan.keptSymbols).toBe(2)
    expect(scan.totalFiles).toBe(4)
  })

  it("gives the withdrawals their own stderr line, apart from the recoverable count", async () => {
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code).toBe(0)
    expect(stderr.text()).toContain("1 file(s) had recoverable parse errors.")
    expect(stderr.text()).toContain("2 file(s) could not be parsed and were left out of the IR.")
  })
})
