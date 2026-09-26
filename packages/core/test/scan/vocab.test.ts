import { noopRegistry } from "@aburi/test-support"
import type {
  EffectPlugin,
  ExtKind,
  FrameworkPlugin,
  OpaqueAstNode,
  SymbolCandidate,
  VocabRegistry,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CoreError, scan } from "../../src"
import {
  effectsManifest,
  frameworkManifest,
  stubCandidate,
  stubLanguagePlugin,
  useStubWorkspace,
} from "../fixtures/plugins"

/**
 * `config.strict` (config.md, extension-vocab.md): a value a plugin emits has to be claimed by
 * that plugin's manifest. Strict by default, a run stops at the first one; with strict off it
 * carries on and hands every one back.
 */

/** Owns exactly the pairs listed, as `VocabRegistry` does after loading manifests. */
function registryOwning(owned: { effects?: [string, string][]; extKinds?: [string, string][] }) {
  const effects = new Map(owned.effects ?? [])
  const extKinds = new Map(owned.extKinds ?? [])
  const registry: VocabRegistry = {
    ...noopRegistry,
    isEffectOwnedBy: (id, plugin) => effects.get(id) === plugin,
    isExtKindOwnedBy: (id, plugin) => extKinds.get(id) === plugin,
  }
  return registry
}

/** One Symbol per file, calling `target` on line 4, with `extKind` from the language itself. */
function language(extKind: string | null = null) {
  return stubLanguagePlugin({
    extractSymbols: (_tree, ctx) => [
      stubCandidate(ctx.file.path === "bad.stub" ? "twin" : "only", {
        file: ctx.file.path,
        extKind: extKind as ExtKind,
      }),
      ...(ctx.file.path === "bad.stub"
        ? [stubCandidate("twin", { file: ctx.file.path, extKind: extKind as ExtKind })]
        : []),
    ],
    walkBody: () => ({
      rules: [],
      calls: [
        {
          target: "acme.ping",
          line: 4,
          argumentCount: 0,
          inAwait: false,
          inNew: false,
          literalArgs: [],
        },
      ],
    }),
  })
}

function effectPlugin(name: string, effectId: string): EffectPlugin {
  return {
    manifest: effectsManifest(name),
    init: async () => {},
    classify: () => ({ effectId: effectId as never, confidence: "high", derivedBy: `${name}:x` }),
  }
}

function frameworkPlugin(name: string, extKind: string): FrameworkPlugin {
  return {
    manifest: frameworkManifest(name),
    init: async () => {},
    classifySymbol: (_symbol: SymbolCandidate<OpaqueAstNode>) => ({
      extKind: extKind as ExtKind,
      derivedBy: `${name}:x`,
    }),
  } as FrameworkPlugin
}

const workspace = useStubWorkspace("vocab")

function run(options: {
  strict?: boolean
  registry: VocabRegistry
  effects?: EffectPlugin[]
  frameworks?: FrameworkPlugin[]
  languageExtKind?: string
}) {
  return scan({
    workspaceRoot: workspace.root,
    config: options.strict === undefined ? {} : { strict: options.strict },
    languages: [language(options.languageExtKind ?? null)],
    frameworks: options.frameworks ?? [],
    effects: options.effects ?? [],
    registry: options.registry,
    components: [],
  })
}

describe("a strict run (the default)", () => {
  it("V6: ends at an effect id the emitting plugin does not claim, naming plugin, value and place", async () => {
    const outcome = run({
      registry: registryOwning({}),
      effects: [effectPlugin("effects-acme", "x-acme:ping")],
    })
    await expect(outcome).rejects.toBeInstanceOf(CoreError)
    await expect(outcome).rejects.toMatchObject({
      code: "vocab-undeclared",
      value: "x-acme:ping",
      message: expect.stringContaining(
        'Plugin "effects-acme" emitted effect "x-acme:ping" at a.stub:4',
      ),
    })
  })

  it("ends at an id another plugin owns, since ownership is per plugin", async () => {
    const outcome = run({
      registry: registryOwning({ effects: [["x-acme:ping", "effects-other"]] }),
      effects: [effectPlugin("effects-acme", "x-acme:ping")],
    })
    await expect(outcome).rejects.toMatchObject({ code: "vocab-undeclared" })
  })

  it("passes a core effect id, which no plugin owns", async () => {
    const { ir } = await run({
      registry: registryOwning({}),
      effects: [effectPlugin("effects-acme", "db.read")],
    })
    expect(ir.symbols.flatMap((s) => s.effects.map((e) => e.id))).toContain("db.read")
  })

  it("V10: passes an effect id and an extKind their emitting plugins claim", async () => {
    const result = await run({
      registry: registryOwning({
        effects: [["x-acme:ping", "effects-acme"]],
        extKinds: [["framework:acme:job", "framework-acme"]],
      }),
      effects: [effectPlugin("effects-acme", "x-acme:ping")],
      frameworks: [frameworkPlugin("framework-acme", "framework:acme:job")],
    })
    expect(result.undeclaredVocab).toEqual([])
  })

  it("V7: ends at an extKind a framework plugin does not claim", async () => {
    await expect(
      run({
        registry: registryOwning({}),
        frameworks: [frameworkPlugin("framework-acme", "framework:acme:job")],
      }),
    ).rejects.toMatchObject({
      code: "vocab-undeclared",
      message: expect.stringContaining('Plugin "framework-acme" emitted extKind'),
    })
  })

  it("charges an extKind the language plugin set, and no framework replaced, to the language plugin", async () => {
    await expect(
      run({ registry: registryOwning({}), languageExtKind: "lang:stub:thing" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Plugin "lang-stub" emitted extKind'),
    })
  })
})

describe("a run with strict off", () => {
  it("keeps the effect and records where it came from", async () => {
    const result = await run({
      strict: false,
      registry: registryOwning({}),
      effects: [effectPlugin("effects-acme", "x-acme:ping")],
    })
    expect(result.ir.symbols.flatMap((s) => s.effects.map((e) => e.id))).toContain("x-acme:ping")
    expect(result.undeclaredVocab).toContainEqual({
      kind: "effect",
      value: "x-acme:ping",
      plugin: "effects-acme",
      file: "a.stub",
      line: 4,
      symbol: "stub:a.stub#only",
    })
  })

  it("records an extKind with no line", async () => {
    const result = await run({
      strict: false,
      registry: registryOwning({}),
      frameworks: [frameworkPlugin("framework-acme", "framework:acme:job")],
    })
    expect(result.undeclaredVocab).toContainEqual({
      kind: "extKind",
      value: "framework:acme:job",
      plugin: "framework-acme",
      file: "c.stub",
      line: null,
      symbol: "stub:c.stub#only",
    })
  })

  it("drops what a withdrawn file emitted, since the Document holds none of its Symbols", async () => {
    const result = await run({
      strict: false,
      registry: registryOwning({}),
      effects: [effectPlugin("effects-acme", "x-acme:ping")],
    })
    expect(result.skipped.map((s) => s.path)).toEqual(["bad.stub"])
    expect(result.undeclaredVocab.map((o) => o.file)).toEqual(["a.stub", "c.stub"])
  })
})
