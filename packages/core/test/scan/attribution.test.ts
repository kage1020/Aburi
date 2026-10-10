import { component, makeCall, useScratchWorkspace } from "@aburi/test-support"
import type { Component, ComponentId } from "@aburi/types"
import { beforeEach, describe, expect, it } from "vitest"
import { buildComponentAttribution, serializeCanonical } from "../../src"
import {
  fileCandidate,
  scanStubs,
  stubCandidate,
  stubEffectsPlugin,
  stubLanguagePlugin,
} from "../fixtures/plugins"

function rooted(id: string, ...roots: string[]): Component {
  return component({ id, name: id, roots })
}

const NESTED = [
  rooted("root", "."),
  rooted("api", "packages/api"),
  rooted("api-internal", "packages/api/internal"),
]
const API = [rooted("api", "packages/api")]

describe("buildComponentAttribution", () => {
  it.each<[string, Component[], string, string | null]>([
    ["gives a file to its deepest root", NESTED, "packages/api/internal/db.ts", "api-internal"],
    [
      "gives a file under a shallower root to that one",
      NESTED,
      "packages/api/src/orders.ts",
      "api",
    ],
    [
      "gives a file under no other root to the workspace root",
      NESTED,
      "scripts/release.ts",
      "root",
    ],
    ["gives a file under no root at all to nobody", API, "scripts/release.ts", null],
    ["gives a file at the top level to nobody when no root covers it", API, "index.ts", null],
    [
      "gives every file to nobody when no component is declared",
      [],
      "packages/api/src/orders.ts",
      null,
    ],
    [
      "matches whole path segments, not string prefixes",
      API,
      "packages/api-legacy/src/orders.ts",
      null,
    ],
    [
      "lets a root name a single file",
      [rooted("gen", "packages/api/gen.ts")],
      "packages/api/gen.ts",
      "gen",
    ],
    [
      "gives a root two components claim to the lower id",
      [rooted("web", "packages/shared"), rooted("api", "packages/shared")],
      "packages/shared/util.ts",
      "api",
    ],
    [
      "gives a root two components claim to the lower id, listed the other way round",
      [rooted("api", "packages/shared"), rooted("web", "packages/shared")],
      "packages/shared/util.ts",
      "api",
    ],
    [
      "orders colliding ids as strings, not as numbers",
      [rooted("svc-9", "packages/shared"), rooted("svc-10", "packages/shared")],
      "packages/shared/util.ts",
      "svc-10",
    ],
    [
      "reads a root written with a leading ./ and a trailing slash as the directory",
      [rooted("api", "./packages/api/"), rooted("root", "./")],
      "packages/api/src/orders.ts",
      "api",
    ],
    [
      "reads ./ as the workspace root",
      [rooted("api", "./packages/api/"), rooted("root", "./")],
      "scripts/release.ts",
      "root",
    ],
    [
      "reads a file written with a leading ./ as the same path",
      NESTED,
      "./packages/api/x.ts",
      "api",
    ],
    ["reads a ./ segment inside a file path as nothing", NESTED, "packages/./api/x.ts", "api"],
    [
      "repairs an empty segment in a root",
      [rooted("api", "packages//api")],
      "packages/api/src/orders.ts",
      "api",
    ],
    ["repairs an empty segment in a file path", API, "packages//api//src/orders.ts", "api"],
    [
      "claims nothing for a root that names nothing",
      [rooted("nowhere", ""), rooted("also-nowhere", "/"), rooted("outside", "../vendor")],
      "packages/api/src/orders.ts",
      null,
    ],
    [
      "claims nothing for a file that ascends out of the workspace",
      NESTED,
      "../outside/z.ts",
      null,
    ],
    ["claims nothing for an empty path", NESTED, "", null],
    [
      "matches a decomposed path against a composed root",
      [rooted("cafe", "packages/café")],
      "packages/café/menu.ts".normalize("NFD"),
      "cafe",
    ],
  ])("%s", (_label, components, file, owner) => {
    expect(buildComponentAttribution(components)(file)).toBe(owner)
  })
})

describe("scan — attribution", () => {
  const workspace = useScratchWorkspace("attribution")
  const components = [rooted("api", "packages/api"), rooted("web", "packages/web")]

  beforeEach(async () => {
    await workspace.writeSource("packages/api/src/orders.stub", "a")
    await workspace.writeSource("packages/web/page.stub", "b")
    await workspace.writeSource("scripts/release.stub", "c")
  })

  /** Each file declares one function with a body and one without, which is dropped. */
  const twoPerFile = stubLanguagePlugin({
    extractSymbols: (_tree, ctx) => {
      const kept = fileCandidate(ctx.file.path)
      return [kept, stubCandidate(`${kept.name}_declared`, { file: ctx.file.path, bodyNode: null })]
    },
    walkBody: () => ({ rules: [], calls: [makeCall({ target: "db.query" })] }),
  })

  function scanWorkspace(seen: (ComponentId | null)[] = []) {
    return scanStubs(workspace.root, {
      languages: [twoPerFile],
      effects: [
        stubEffectsPlugin("effects-stub", (_call, ctx) => {
          seen.push(ctx.owner.component)
          return null
        }),
      ],
      components,
    })
  }

  it("attributes every Symbol, kept or dropped, to the component holding its file", async () => {
    const { ir } = await scanWorkspace()

    expect(ir.symbols.map((s) => [s.source.file, s.dropped, s.component])).toEqual([
      ["packages/api/src/orders.stub", false, "api"],
      ["packages/api/src/orders.stub", true, "api"],
      ["packages/web/page.stub", false, "web"],
      ["packages/web/page.stub", true, "web"],
      ["scripts/release.stub", false, null],
      ["scripts/release.stub", true, null],
    ])
  })

  it("writes the component key into the serialized bytes, `null` included", async () => {
    const { ir } = await scanWorkspace()
    const written = JSON.parse(serializeCanonical(ir)) as { symbols: Record<string, unknown>[] }

    expect(written.symbols.map((symbol) => symbol.component)).toEqual([
      "api",
      "api",
      "web",
      "web",
      null,
      null,
    ])
  })

  it("hands an effect plugin the owner's component", async () => {
    const seen: (ComponentId | null)[] = []
    await scanWorkspace(seen)
    expect(seen).toEqual(["api", "web", null])
  })

  it("resolves a qualified name to the callee in the caller's own component", async () => {
    await workspace.writeSource("packages/api/src/pricing.stub", "p")
    await workspace.writeSource("packages/web/pricing.stub", "p")
    const isCallee = (file: string) => file.endsWith("pricing.stub")
    const pricing = stubLanguagePlugin({
      extractSymbols: (_tree, ctx) =>
        isCallee(ctx.file.path)
          ? [stubCandidate("Pricing.calc", { file: ctx.file.path, kind: "method" })]
          : [fileCandidate(ctx.file.path)],
      walkBody: (symbol) => ({
        rules: [],
        calls: isCallee(symbol.source.file) ? [] : [makeCall({ target: "Pricing.calc" })],
      }),
    })

    const { ir } = await scanStubs(workspace.root, { languages: [pricing], components })

    const resolvedFrom = (file: string) =>
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
