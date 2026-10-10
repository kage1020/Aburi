import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noopRegistry } from "@aburi/test-support"
import type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  Component,
  ComponentId,
  EffectClassification,
  EffectPlugin,
  ExtractionContext,
  LanguagePlugin,
  OpaqueAstNode,
  ParseResult,
  SourceFile,
  SymbolCandidate,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildComponentAttribution,
  makeComponentId,
  makeLanguageId,
  scan,
  serializeCanonical,
} from "../../src"
import { symbolId } from "../fixtures/ir"
import { effectsManifest, stubLanguagePlugin } from "../fixtures/plugins"

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

    expect(attribution("packages/api/internal/db.ts")).toBe("api-internal")
    expect(attribution("packages/api/src/orders.ts")).toBe("api")
    expect(attribution("scripts/release.ts")).toBe("root")
  })

  it("answers null for a file under no root at all", () => {
    const attribution = buildComponentAttribution([component("api", ["packages/api"])])

    expect(attribution("scripts/release.ts")).toBeNull()
    expect(attribution("index.ts")).toBeNull()
  })

  it("answers null for every file when the caller declared no components", () => {
    const attribution = buildComponentAttribution([])

    expect(attribution("packages/api/src/orders.ts")).toBeNull()
  })

  it("matches whole path segments, not string prefixes", () => {
    const attribution = buildComponentAttribution([component("api", ["packages/api"])])

    expect(attribution("packages/api-legacy/src/orders.ts")).toBeNull()
  })

  it("lets a root name a single file", () => {
    const attribution = buildComponentAttribution([component("gen", ["packages/api/gen.ts"])])

    expect(attribution("packages/api/gen.ts")).toBe("gen")
  })

  it("gives a root two components claim to the lower of their ids, either way round", () => {
    const shared = ["packages/shared"]
    const forwards = buildComponentAttribution([component("web", shared), component("api", shared)])
    const backwards = buildComponentAttribution([
      component("api", shared),
      component("web", shared),
    ])

    expect(forwards("packages/shared/util.ts")).toBe("api")
    expect(backwards("packages/shared/util.ts")).toBe("api")
  })

  it("orders colliding ids as strings, not as numbers", () => {
    const shared = ["packages/shared"]
    const attribution = buildComponentAttribution([
      component("svc-9", shared),
      component("svc-10", shared),
    ])

    expect(attribution("packages/shared/util.ts")).toBe("svc-10")
  })

  it("reads a root spelled with a leading ./ or a trailing slash as the same directory", () => {
    const attribution = buildComponentAttribution([
      component("api", ["./packages/api/"]),
      component("root", ["./"]),
    ])

    expect(attribution("packages/api/src/orders.ts")).toBe("api")
    expect(attribution("scripts/release.ts")).toBe("root")
  })

  it("reads a *file* spelled with a leading ./ as the same path", () => {
    const attribution = buildComponentAttribution([
      component("root", ["."]),
      component("web", ["apps/web"]),
    ])

    expect(attribution("./apps/web/x.ts")).toBe("web")
    expect(attribution("apps/./web/x.ts")).toBe("web")
  })

  it("repairs an empty path segment on either side", () => {
    const attribution = buildComponentAttribution([component("api", ["packages//api"])])

    expect(attribution("packages/api/src/orders.ts")).toBe("api")
    expect(attribution("packages//api//src/orders.ts")).toBe("api")
  })

  it("claims nothing for a root that names nothing", () => {
    const attribution = buildComponentAttribution([
      component("nowhere", [""]),
      component("also-nowhere", ["/"]),
      component("outside", ["../vendor"]),
    ])

    expect(attribution("packages/api/src/orders.ts")).toBeNull()
    expect(attribution("index.ts")).toBeNull()
  })

  it("claims nothing for a file that ascends out of the workspace", () => {
    const attribution = buildComponentAttribution([component("root", ["."])])

    expect(attribution("../outside/z.ts")).toBeNull()
    expect(attribution("")).toBeNull()
  })

  it("matches a decomposed path against a composed root", () => {
    const attribution = buildComponentAttribution([component("cafe", ["packages/café"])])

    expect(attribution("packages/café/menu.ts".normalize("NFD"))).toBe("cafe")
  })
})

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
  return stubLanguagePlugin({
    parseFile: async (file: SourceFile): Promise<ParseResult> => ({
      tree: { path: file.path } as unknown as OpaqueAstNode,
      errors: [],
      imports: [],
    }),
    extractSymbols: (_tree: OpaqueAstNode, ctx: ExtractionContext) => candidates(ctx.file.path),
    walkBody: (): BodyExtraction => ({
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
  })
}

/** Records the `owner.component` every call was classified against. */
function recordingEffects(seen: (ComponentId | null)[]): EffectPlugin {
  const plugin: EffectPlugin = {
    manifest: effectsManifest(),
    init: async () => {},
    classify: (_call: CallCandidate, ctx: ClassifyContext): EffectClassification | null => {
      seen.push(ctx.owner.component)
      return null
    },
  }
  return plugin
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

  it("attributes a dropped Symbol as it does a kept one", async () => {
    const { ir } = await scanWorkspace()

    const dropped = ir.symbols.filter((symbol) => symbol.dropped)
    expect(dropped.length).toBeGreaterThan(0)
    const inApi = dropped.filter((symbol) => symbol.source.file.startsWith("packages/api/"))
    expect(inApi).toHaveLength(1)
    expect(inApi[0]?.component).toBe("api")
  })

  it("writes the component key into the serialized bytes, `null` included", async () => {
    const { ir } = await scanWorkspace()
    const written = JSON.parse(serializeCanonical(ir)) as {
      symbols: Array<Record<string, unknown>>
    }

    expect(written.symbols.length).toBe(ir.symbols.length)
    for (const symbol of written.symbols) {
      expect(Object.hasOwn(symbol, "component")).toBe(true)
    }
    const outside = written.symbols.filter(
      (symbol) => (symbol.source as { file: string }).file === "scripts/release.stub",
    )
    expect(outside.length).toBeGreaterThan(0)
    for (const symbol of outside) expect(symbol.component).toBeNull()
  })

  it("hands an effect plugin the owner's component rather than null", async () => {
    const seen: (ComponentId | null)[] = []
    await scanWorkspace(seen)

    expect(new Set(seen)).toEqual(new Set(["api", "web", null]))
  })
})

function pricingLanguage(): LanguagePlugin {
  const isCallee = (file: string): boolean => file.endsWith("pricing.stub")
  const plugin: LanguagePlugin = {
    ...stubLanguage(),
    extractSymbols: (_tree: OpaqueAstNode, ctx: ExtractionContext) => {
      const file = ctx.file.path
      const shared = {
        extKind: null,
        visibility: "public" as const,
        decorators: [],
        signature: null,
        derivedBy: [],
        bodyNode: {} as OpaqueAstNode,
        fullNode: {} as OpaqueAstNode,
        source: { file, startLine: 1, endLine: 2, startColumn: null, endColumn: null },
      }
      if (isCallee(file)) {
        return [
          {
            ...shared,
            id: symbolId(`stub:${file}#Pricing.calc`),
            kind: "method" as const,
            name: "Pricing.calc",
          },
        ]
      }
      const base = file.replace(/[^A-Za-z0-9]/g, "_")
      return [
        { ...shared, id: symbolId(`stub:${file}#${base}`), kind: "function" as const, name: base },
      ]
    },
    walkBody: (symbol: SymbolCandidate<OpaqueAstNode>): BodyExtraction => ({
      rules: [],
      calls: isCallee(symbol.source.file)
        ? []
        : [
            {
              target: "Pricing.calc",
              line: 1,
              argumentCount: 0,
              inAwait: false,
              inNew: false,
              literalArgs: [],
            },
          ],
    }),
  }
  return plugin
}

describe("call resolution over an attributed workspace", () => {
  beforeEach(async () => {
    await writeFile(join(workRoot, "packages", "api", "src", "pricing.stub"), "p", "utf8")
    await writeFile(join(workRoot, "packages", "web", "pricing.stub"), "p", "utf8")
  })

  async function scanPricingWorkspace() {
    return scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [pricingLanguage()],
      frameworks: [],
      effects: [],
      registry: noopRegistry,
      components: [component("api", ["packages/api"]), component("web", ["packages/web"])],
    })
  }

  it("resolves a qualified name to the callee in the caller's own component", async () => {
    const { ir } = await scanPricingWorkspace()

    const resolvedFrom = (file: string): string | null | undefined =>
      ir.symbols.find((symbol) => symbol.source.file === file)?.calls[0]?.resolved

    expect(resolvedFrom("packages/api/src/orders.stub")).toBe(
      "stub:packages/api/src/pricing.stub#Pricing.calc",
    )
    expect(resolvedFrom("packages/web/page.stub")).toBe(
      "stub:packages/web/pricing.stub#Pricing.calc",
    )
    expect(resolvedFrom("scripts/release.stub")).toBeNull()
  })
})
