import { decorator, importEdge, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type { Decorator, ImportEdge, LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  fileCandidate,
  scanStubs,
  stubFrameworkPlugin,
  stubLanguagePlugin,
} from "../fixtures/plugins"

const workspace = useScratchWorkspace("import-origins")

/** What a `.stub` file holds: its import edges, and the decorators of the one Symbol it declares. */
interface Module {
  imports?: readonly ImportEdge[]
  decorators?: readonly Decorator[]
}

type Aliases = Readonly<Record<string, readonly string[]>>

const CONSUMER = "src/app.stub"
const BARREL = "libs/common/index.stub"
const ALIASES: Aliases = { "@app/common": [BARREL] }
const decorated = [decorator({ name: "Decorate" })]

function named(source: string, ...symbols: string[]): ImportEdge {
  return importEdge({ source, symbols })
}

interface Recorder {
  parsed: string[]
  released: unknown[]
  resolversCreated: number
}

function moduleLanguage(
  aliases: Aliases,
  recorder: Recorder = { parsed: [], released: [], resolversCreated: 0 },
  resolve?: (specifier: string) => Promise<readonly string[]>,
): LanguagePlugin {
  const read = (content: string): Module => JSON.parse(content) as Module
  return stubLanguagePlugin({
    parseFile: async (file) => {
      recorder.parsed.push(file.path)
      return {
        tree: { file: file.path },
        errors: [],
        imports: [...(read(file.content).imports ?? [])],
      }
    },
    releaseTree: (tree) => {
      recorder.released.push(tree)
    },
    extractSymbols: (_tree, ctx) => [
      fileCandidate(ctx.file.path, { decorators: [...(read(ctx.file.content).decorators ?? [])] }),
    ],
    createImportResolver: () => {
      recorder.resolversCreated++
      return { resolve: resolve ?? (async (specifier) => aliases[specifier] ?? []) }
    },
  })
}

/** The import edges each file's framework classification was handed, by file. */
async function importsSeen(
  modules: Readonly<Record<string, Module>>,
  language: LanguagePlugin = moduleLanguage(ALIASES),
  logger = recordingLogger(),
): Promise<Map<string, readonly ImportEdge[]>> {
  for (const [path, module] of Object.entries(modules)) {
    await workspace.writeSource(path, JSON.stringify(module))
  }
  const seen = new Map<string, readonly ImportEdge[]>()
  const framework = stubFrameworkPlugin("framework-stub", {
    classifySymbol: (_symbol, ctx) => {
      seen.set(ctx.file.path, ctx.imports)
      return null
    },
  })
  await scanStubs(workspace.root, { languages: [language], frameworks: [framework], logger })
  return seen
}

function originsOf(imports: readonly ImportEdge[] | undefined): [string, object | null][] {
  return (imports ?? []).map((edge) => [
    edge.source,
    edge.origins === undefined ? null : Object.fromEntries(edge.origins),
  ])
}

describe("scan — where a decorator's imported name is declared", () => {
  it.each<[string, Readonly<Record<string, Module>>, [string, object | null][]]>([
    [
      "a path alias to a barrel that re-exports a package",
      {
        [CONSUMER]: { imports: [named("@app/common", "Decorate")], decorators: decorated },
        [BARREL]: { imports: [named("@vendor/kit", "Decorate")] },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a relative barrel two re-exports deep",
      {
        [CONSUMER]: { imports: [named("./barrel.stub", "Decorate")], decorators: decorated },
        "src/barrel.stub": { imports: [named("./inner.stub", "Decorate")] },
        "src/inner.stub": { imports: [named("@vendor/kit", "Decorate")] },
      },
      [["./barrel.stub", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a decorator renamed on import, keyed by the name the barrel exports",
      {
        [CONSUMER]: {
          imports: [named("@app/common", "Decorate as D")],
          decorators: [decorator({ name: "D" })],
        },
        [BARREL]: { imports: [named("@vendor/kit", "Decorate")] },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a namespace import a qualified decorator reads through",
      {
        [CONSUMER]: {
          imports: [importEdge({ source: "@app/common", symbols: "*", namespaceBinding: "ns" })],
          decorators: [decorator({ name: "Decorate", qualifier: "ns" })],
        },
        [BARREL]: { imports: [named("@vendor/kit", "Decorate")] },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a barrel that reaches the name only through `export *`",
      {
        [CONSUMER]: { imports: [named("@app/common", "Decorate")], decorators: decorated },
        [BARREL]: { imports: [importEdge({ source: "@vendor/kit", symbols: "*" })] },
      },
      [["@app/common", null]],
    ],
    [
      "a barrel that declares the name itself",
      {
        [CONSUMER]: { imports: [named("@app/common", "Decorate")], decorators: decorated },
        [BARREL]: { imports: [named("@vendor/kit", "Other")] },
      },
      [["@app/common", null]],
    ],
    [
      "a re-export of a relative module the workspace does not hold",
      {
        [CONSUMER]: { imports: [named("@app/common", "Decorate")], decorators: decorated },
        [BARREL]: { imports: [named("./missing.stub", "Decorate")] },
      },
      [["@app/common", null]],
    ],
    [
      "two barrels re-exporting the name from each other",
      {
        [CONSUMER]: { imports: [named("./a.stub", "Decorate")], decorators: decorated },
        "src/a.stub": { imports: [named("./b.stub", "Decorate")] },
        "src/b.stub": { imports: [named("./a.stub", "Decorate")] },
      },
      [["./a.stub", null]],
    ],
    [
      "a specifier the language maps nowhere",
      {
        [CONSUMER]: { imports: [named("@vendor/kit", "Decorate")], decorators: decorated },
      },
      [["@vendor/kit", null]],
    ],
    [
      "a name no decorator uses",
      {
        [CONSUMER]: {
          imports: [named("@vendor/kit", "Decorate"), named("@app/common", "helper")],
          decorators: decorated,
        },
        [BARREL]: { imports: [named("@vendor/util", "helper")] },
      },
      [
        ["@vendor/kit", null],
        ["@app/common", null],
      ],
    ],
  ])("follows %s", async (_case, modules, expected) => {
    const seen = await importsSeen(modules)
    expect(originsOf(seen.get(CONSUMER))).toEqual(expected)
  })

  it("parses a barrel once beyond its own turn, however many files import it, and frees each tree", async () => {
    const recorder: Recorder = { parsed: [], released: [], resolversCreated: 0 }
    const consumer = { imports: [named("@app/common", "Decorate")], decorators: decorated }
    const seen = await importsSeen(
      {
        "a.stub": consumer,
        "b.stub": consumer,
        "c.stub": consumer,
        "z/barrel.stub": { imports: [named("@vendor/kit", "Decorate")] },
      },
      moduleLanguage({ "@app/common": ["z/barrel.stub"] }, recorder),
    )

    expect(recorder.parsed.filter((path) => path === "z/barrel.stub")).toHaveLength(2)
    expect(recorder.released).toHaveLength(recorder.parsed.length)
    expect(recorder.resolversCreated).toBe(1)
    for (const file of ["a.stub", "b.stub", "c.stub"]) {
      expect(originsOf(seen.get(file))).toEqual([["@app/common", { Decorate: "@vendor/kit" }]])
    }
  })

  it("asks for no resolver when no framework plugin would read an origin", async () => {
    const recorder: Recorder = { parsed: [], released: [], resolversCreated: 0 }
    await workspace.writeSource(
      CONSUMER,
      JSON.stringify({ imports: [named("@app/common", "Decorate")], decorators: decorated }),
    )
    await scanStubs(workspace.root, { languages: [moduleLanguage(ALIASES, recorder)] })

    expect(recorder.resolversCreated).toBe(0)
    expect(recorder.parsed).toEqual([CONSUMER])
  })

  it("warns once when the resolver throws, and leaves each specifier as written", async () => {
    const logger = recordingLogger()
    const consumer = {
      imports: [named("@app/common", "Decorate"), named("@app/other", "Decorate as D")],
      decorators: [...decorated, decorator({ name: "D" })],
    }
    const seen = await importsSeen(
      { [CONSUMER]: consumer, "src/second.stub": consumer },
      moduleLanguage(ALIASES, undefined, async () => {
        throw new Error("tsconfig unreadable")
      }),
      logger,
    )

    expect(originsOf(seen.get(CONSUMER))).toEqual([
      ["@app/common", null],
      ["@app/other", null],
    ])
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toMatch(/lang-stub.*tsconfig unreadable/)
  })
})
