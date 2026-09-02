import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  Component,
  ComponentId,
  EffectClassification,
  EffectPlugin,
  EffectsManifest,
  ExtractionContext,
  LangManifest,
  LanguagePlugin,
  OpaqueAstNode,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildComponentAttribution, makeComponentId, makeLanguageId, scan } from "../../src"
import { symbolId } from "../fixtures/ir"

/**
 * Every Symbol says which Component it belongs to, and `Component.roots[]` is the whole of
 * what decides it — a file under a root is that Component's, and the deepest root claiming
 * it wins. Before this existed the field was `null` on every Symbol, so a workspace of
 * nineteen Symbols reported `0` against each of its components and every per-component
 * artefact was a header with nothing under it.
 *
 * The first half of the file is the rule on its own, over paths rather than a filesystem.
 * The second half is one scan, because the rule is only worth anything if what reaches the
 * IR carries it — including the Symbols the drop rules refuse and the `owner` an effect
 * plugin classifies against.
 */

function component(id: string, roots: readonly string[]): Component {
  return {
    id: makeComponentId(id),
    name: id,
    roots: [...roots],
    languages: [makeLanguageId("ts")],
    description: null,
  }
}

describe("buildComponentAttribution", () => {
  it("gives a file to the component whose root is the longest prefix of it", () => {
    const attribution = buildComponentAttribution([
      component("root", ["."]),
      component("api", ["packages/api"]),
      component("api-internal", ["packages/api/internal"]),
    ])

    expect(attribution.attribute("packages/api/internal/db.ts")).toBe("api-internal")
    expect(attribution.attribute("packages/api/src/orders.ts")).toBe("api")
    expect(attribution.attribute("scripts/release.ts")).toBe("root")
  })

  it("answers null for a file under no root at all", () => {
    const attribution = buildComponentAttribution([component("api", ["packages/api"])])

    expect(attribution.attribute("scripts/release.ts")).toBeNull()
    expect(attribution.attribute("index.ts")).toBeNull()
  })

  it("answers null for every file when the caller declared no components", () => {
    const attribution = buildComponentAttribution([])

    expect(attribution.attribute("packages/api/src/orders.ts")).toBeNull()
  })

  it("matches whole path segments, not string prefixes", () => {
    const attribution = buildComponentAttribution([component("api", ["packages/api"])])

    expect(attribution.attribute("packages/api-legacy/src/orders.ts")).toBeNull()
  })

  it("lets a root name a single file", () => {
    const attribution = buildComponentAttribution([component("gen", ["packages/api/gen.ts"])])

    expect(attribution.attribute("packages/api/gen.ts")).toBe("gen")
  })

  it("gives a root two components claim to the lower of their ids", () => {
    const shared = ["packages/shared"]
    const forwards = buildComponentAttribution([component("web", shared), component("api", shared)])
    const backwards = buildComponentAttribution([
      component("api", shared),
      component("web", shared),
    ])

    expect(forwards.attribute("packages/shared/util.ts")).toBe("api")
    expect(backwards.attribute("packages/shared/util.ts")).toBe("api")
  })

  it("reads a root spelled with a leading ./ or a trailing slash as the same directory", () => {
    const attribution = buildComponentAttribution([
      component("api", ["./packages/api/"]),
      component("root", ["./"]),
    ])

    expect(attribution.attribute("packages/api/src/orders.ts")).toBe("api")
    expect(attribution.attribute("scripts/release.ts")).toBe("root")
  })

  it("matches a decomposed path against a composed root", () => {
    const attribution = buildComponentAttribution([component("cafe", ["packages/café"])])

    expect(attribution.attribute("packages/café/menu.ts".normalize("NFD"))).toBe("cafe")
  })
})

/* --- one scan, over a workspace of two components ------------------------------------- */

const noopRegistry: VocabRegistry = {
  findEffect: () => null,
  findExtKind: () => null,
  findFramework: () => null,
  findDerivedByOwner: () => null,
  isEffectOwnedBy: () => false,
  isExtKindOwnedBy: () => false,
  listEffects: () => [],
  listExtKinds: () => [],
  listFrameworks: () => [],
  listPlugins: () => [],
  assertEffectDeclared: () => {},
  assertExtKindDeclared: () => {},
}

function langManifest(): LangManifest {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
}

function effectsManifest(): EffectsManifest {
  return {
    ...langManifest(),
    name: "effects-stub",
    type: "effects",
  } as unknown as EffectsManifest
}

/**
 * Two Symbols per file: one ordinary, and one the Category B rules drop for having no body
 * (`drop-list.md`). A dropped Symbol keeps its place in the IR, so it has to keep its
 * component with it — the per-component Markdown counts it in its own column.
 */
function candidates(file: string): SymbolCandidate<OpaqueAstNode>[] {
  const base = file.replace(/[^A-Za-z0-9]/g, "_")
  const shared = {
    kind: "function" as const,
    extKind: null,
    visibility: "public" as const,
    decorators: [],
    signature: null,
    derivedBy: [],
    fullNode: {} as OpaqueAstNode,
  }
  return [
    {
      ...shared,
      id: symbolId(`stub:${file}#${base}`),
      name: base,
      source: { file, startLine: 1, endLine: 2, startColumn: null, endColumn: null },
      bodyNode: {} as OpaqueAstNode,
    },
    {
      ...shared,
      id: symbolId(`stub:${file}#${base}_declared`),
      name: `${base}_declared`,
      source: { file, startLine: 3, endLine: 3, startColumn: null, endColumn: null },
      bodyNode: null,
    },
  ]
}

function stubLanguage(): LanguagePlugin {
  const plugin = {
    manifest: langManifest(),
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
    parseFile: async (file: SourceFile): Promise<ParseResult> => ({
      tree: { path: file.path } as unknown as OpaqueAstNode,
      errors: [],
      imports: [],
    }),
    extractSymbols: (_tree: OpaqueAstNode, ctx: ExtractionContext) => candidates(ctx.file.path),
    walkBody: (
      _symbol: SymbolCandidate<OpaqueAstNode>,
      _ctx: WalkContext<OpaqueAstNode>,
    ): BodyExtraction => ({
      rules: [],
      calls: [
        {
          target: "db.query",
          line: 1,
          argumentCount: 0,
          inAwait: false,
          inNew: false,
          literalArgs: [],
        },
      ],
    }),
    normalizeAst: () => "stub-ast",
  }
  return plugin as unknown as LanguagePlugin
}

/** Records the `owner.component` every call was classified against. */
function recordingEffects(seen: (ComponentId | null)[]): EffectPlugin {
  const plugin = {
    manifest: effectsManifest(),
    init: async () => {},
    classify: (_call: CallCandidate, ctx: ClassifyContext): EffectClassification | null => {
      seen.push(ctx.owner.component)
      return null
    },
  }
  return plugin as unknown as EffectPlugin
}

let workRoot = ""

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-attribution-"))
  await mkdir(join(workRoot, "packages", "api", "src"), { recursive: true })
  await mkdir(join(workRoot, "packages", "web"), { recursive: true })
  await mkdir(join(workRoot, "scripts"), { recursive: true })
  await writeFile(join(workRoot, "packages", "api", "src", "orders.stub"), "a", "utf8")
  await writeFile(join(workRoot, "packages", "web", "page.stub"), "b", "utf8")
  await writeFile(join(workRoot, "scripts", "release.stub"), "c", "utf8")
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function scanWorkspace(seen: (ComponentId | null)[] = []) {
  return scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [stubLanguage()],
    frameworks: [],
    effects: [recordingEffects(seen)],
    registry: noopRegistry,
    components: [component("api", ["packages/api"]), component("web", ["packages/web"])],
  })
}

describe("a scan of a two-component workspace", () => {
  it("attributes each Symbol to the component holding its file", async () => {
    const { ir } = await scanWorkspace()

    const byComponent = new Map<string | null, string[]>()
    for (const symbol of ir.symbols) {
      const key = symbol.component ?? null
      byComponent.set(key, [...(byComponent.get(key) ?? []), symbol.source.file])
    }

    expect(new Set(byComponent.get("api"))).toEqual(new Set(["packages/api/src/orders.stub"]))
    expect(new Set(byComponent.get("web"))).toEqual(new Set(["packages/web/page.stub"]))
    // No root covers `scripts/`, and `null` is what a Symbol outside every Component carries.
    expect(new Set(byComponent.get(null))).toEqual(new Set(["scripts/release.stub"]))
  })

  it("writes the key on a dropped Symbol as well as a kept one", async () => {
    const { ir } = await scanWorkspace()

    const dropped = ir.symbols.filter((symbol) => symbol.dropped)
    expect(dropped.length).toBeGreaterThan(0)
    for (const symbol of dropped) {
      expect(Object.hasOwn(symbol, "component")).toBe(true)
    }
    const inApi = dropped.filter((symbol) => symbol.source.file.startsWith("packages/api/"))
    expect(inApi.map((symbol) => symbol.component)).toEqual(inApi.map(() => "api"))
  })

  it("hands an effect plugin the owner's component rather than null", async () => {
    const seen: (ComponentId | null)[] = []
    await scanWorkspace(seen)

    expect(new Set(seen)).toEqual(new Set(["api", "web", null]))
  })
})
