import { fileURLToPath } from "node:url"
import { makeLanguageId, makeSymbolId, serializeCanonical } from "@aburi/core"
import { scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import {
  type LanguagePlugin,
  type ParseResult,
  PLUGIN_SCHEMA_URL,
  type SymbolCandidate,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { createPluginProcess, type PluginProcess } from "../src"
import { isRunning } from "./processes"

const TOY_PARSER = fileURLToPath(new URL("./fixtures/toy-parser.mjs", import.meta.url))

interface ToyFunction {
  name: string
  startLine: number
  endLine: number
  text: string
  calls: { target: string; line: number }[]
}

interface ToyTree {
  pid: number
  functions: ToyFunction[]
}

/** A language plugin whose parser is another process, as one for Python or Go would be. */
function toyLanguage(): { plugin: LanguagePlugin<ToyTree, ToyFunction>; trees: ToyTree[] } {
  const trees: ToyTree[] = []
  let parser: PluginProcess | null = null
  const plugin: LanguagePlugin<ToyTree, ToyFunction> = {
    manifest: {
      $schema: PLUGIN_SCHEMA_URL,
      name: "lang-toy",
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
    },
    languageId: makeLanguageId("toy"),
    fileExtensions: [".toy"],
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
    async init(ctx) {
      parser = createPluginProcess({
        command: process.execPath,
        args: [TOY_PARSER],
        cwd: ctx.workspaceRoot,
      })
    },
    async cleanup() {
      await parser?.close()
    },
    async parseFile(file): Promise<ParseResult<ToyTree>> {
      if (parser === null) throw new Error("lang-toy parsed a file before init")
      const tree = (await parser.request("parse", file)) as ToyTree
      trees.push(tree)
      return { tree, errors: [], imports: [] }
    },
    extractSymbols: (tree, ctx): SymbolCandidate<ToyFunction>[] =>
      tree.functions.map((fn) => ({
        id: makeSymbolId({ language: "toy", file: ctx.file.path, qualifiedName: fn.name }),
        kind: "function",
        extKind: null,
        name: fn.name,
        visibility: "public",
        decorators: [],
        signature: null,
        source: {
          file: ctx.file.path,
          startLine: fn.startLine,
          endLine: fn.endLine,
          startColumn: null,
          endColumn: null,
        },
        derivedBy: [],
        bodyNode: fn,
        fullNode: fn,
      })),
    walkBody: (symbol) => ({
      rules: [],
      calls: (symbol.bodyNode?.calls ?? []).map(({ target, line }) => ({
        target,
        line,
        argumentCount: 0,
        inAwait: false,
        inNew: false,
        literalArgs: [],
      })),
    }),
    normalizeAst: (symbol) => symbol.fullNode.text,
  }
  return { plugin, trees }
}

const workspace = useScratchWorkspace("plugin-process-language")

describe("a language plugin whose parser is another process", () => {
  it("scans on one parser process, ends it with the scan, and scans the same again", async () => {
    await workspace.writeSource("a.toy", "def create\n  call validate\ndef validate\n")
    await workspace.writeSource("b.toy", "def render\n  call create\n")
    const toy = toyLanguage()

    const first = await scanWith(workspace.root, { languages: [toy.plugin] })
    const second = await scanWith(workspace.root, { languages: [toy.plugin] })

    expect(first.ir.symbols.map((symbol) => symbol.id)).toEqual([
      "toy:a.toy#create",
      "toy:a.toy#validate",
      "toy:b.toy#render",
    ])
    expect(first.ir.symbols[0]?.calls.map((call) => call.target)).toEqual(["validate"])
    expect(serializeCanonical(second.ir)).toBe(serializeCanonical(first.ir))
    const [firstScan, secondScan] = [toy.trees.slice(0, 2), toy.trees.slice(2)]
    expect(new Set(firstScan.map((tree) => tree.pid)).size).toBe(1)
    expect(secondScan[0]?.pid).not.toBe(firstScan[0]?.pid)
    expect(toy.trees.map((tree) => isRunning(tree.pid))).toEqual([false, false, false, false])
  })

  it("withdraws the file its parser dies on and extracts the next on a new process", async () => {
    await workspace.writeSource("a.toy", "def create\n")
    await workspace.writeSource("b.toy", "def broken\n!crash\n")
    await workspace.writeSource("c.toy", "def render\n")
    const toy = toyLanguage()

    const result = await scanWith(workspace.root, { languages: [toy.plugin] })

    expect(result.ir.symbols.map((symbol) => symbol.id)).toEqual([
      "toy:a.toy#create",
      "toy:c.toy#render",
    ])
    expect(result.extractionFailures).toEqual([
      {
        file: "b.toy",
        code: "exited",
        message: `${process.execPath} ${TOY_PARSER} exited with code 70`,
      },
    ])
    expect(toy.trees[1]?.pid).not.toBe(toy.trees[0]?.pid)
  })
})
