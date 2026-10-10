import { makeCall, noopRegistry } from "@aburi/test-support"
import type { EffectPlugin, ExtKind, FrameworkPlugin, VocabRegistry } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CoreError, VocabCheck } from "../../src"
import {
  scanStubs,
  stubCandidate,
  stubEffectsPlugin,
  stubFrameworkPlugin,
  stubLanguagePlugin,
  useStubWorkspace,
} from "../fixtures/plugins"

/** Owns exactly the pairs listed, as the plugin registry does after loading manifests. */
function registryOwning(owned: { effects?: [string, string][]; extKinds?: [string, string][] }) {
  const effects = new Map(owned.effects ?? [])
  const extKinds = new Map(owned.extKinds ?? [])
  const refuse = (id: string, plugin: string): never => {
    throw Object.assign(new Error(`"${id}" is not owned by "${plugin}"`), {
      code: "vocab-undeclared",
    })
  }
  const registry: VocabRegistry = {
    ...noopRegistry,
    assertEffectDeclared: (id, plugin) => {
      if (effects.get(id) !== plugin) refuse(id, plugin)
    },
    assertExtKindDeclared: (id, plugin) => {
      if (extKinds.get(id) !== plugin) refuse(id, plugin)
    },
  }
  return registry
}

/** One Symbol per file calling `acme.ping` on line 4, except `bad.stub`, whose two collide. */
function language(extKind: string | null) {
  return stubLanguagePlugin({
    extractSymbols: (_tree, ctx) => {
      const file = ctx.file.path
      const one = (name: string) => stubCandidate(name, { file, extKind: extKind as ExtKind })
      return file === "bad.stub" ? [one("twin"), one("twin")] : [one("only")]
    },
    walkBody: () => ({ rules: [], calls: [makeCall({ target: "acme.ping", line: 4 })] }),
  })
}

function emitting(name: string, effectId: string): EffectPlugin {
  return stubEffectsPlugin(name, () => ({
    effectId: effectId as never,
    confidence: "high",
    derivedBy: `${name}:x`,
  }))
}

function classifying(name: string, extKind: string): FrameworkPlugin {
  return stubFrameworkPlugin(name, {
    classifySymbol: () => ({ extKind: extKind as ExtKind, derivedBy: `${name}:x` }),
  })
}

const workspace = useStubWorkspace("vocab")

function run(options: {
  strict?: boolean
  registry: VocabRegistry
  effects?: EffectPlugin[]
  frameworks?: FrameworkPlugin[]
  languageExtKind?: string
}) {
  return scanStubs(workspace.root, {
    config: options.strict === undefined ? {} : { strict: options.strict },
    languages: [language(options.languageExtKind ?? null)],
    frameworks: options.frameworks ?? [],
    effects: options.effects ?? [],
    registry: options.registry,
  })
}

describe("a strict run (the default)", () => {
  it("ends at an effect id the emitting plugin does not claim, naming plugin, value and place", async () => {
    const outcome = run({
      registry: registryOwning({}),
      effects: [emitting("effects-acme", "x-acme:ping")],
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
      effects: [emitting("effects-acme", "x-acme:ping")],
    })
    await expect(outcome).rejects.toMatchObject({ code: "vocab-undeclared" })
  })

  it("passes a core effect id, which no plugin owns", async () => {
    const { ir } = await run({
      registry: registryOwning({}),
      effects: [emitting("effects-acme", "db.read")],
    })
    expect(ir.symbols.flatMap((s) => s.effects.map((e) => e.id))).toContain("db.read")
  })

  it("passes an effect id and an extKind their emitting plugins claim", async () => {
    const result = await run({
      registry: registryOwning({
        effects: [["x-acme:ping", "effects-acme"]],
        extKinds: [["framework:acme:job", "framework-acme"]],
      }),
      effects: [emitting("effects-acme", "x-acme:ping")],
      frameworks: [classifying("framework-acme", "framework:acme:job")],
    })
    expect(result.undeclaredVocab).toEqual([])
  })

  it.each([
    [
      "a framework plugin",
      { frameworks: [classifying("framework-acme", "framework:acme:job")] },
      "framework-acme",
    ],
    [
      "the language plugin, when no framework replaced it",
      { languageExtKind: "lang:stub:thing" },
      "lang-stub",
    ],
  ])("ends at an extKind %s set without claiming it", async (_label, options, plugin) => {
    await expect(run({ registry: registryOwning({}), ...options })).rejects.toMatchObject({
      code: "vocab-undeclared",
      message: expect.stringContaining(`Plugin "${plugin}" emitted extKind`),
    })
  })
})

describe("a run with strict off", () => {
  it("keeps the effect and records where it came from", async () => {
    const result = await run({
      strict: false,
      registry: registryOwning({}),
      effects: [emitting("effects-acme", "x-acme:ping")],
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
      frameworks: [classifying("framework-acme", "framework:acme:job")],
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
      effects: [emitting("effects-acme", "x-acme:ping")],
    })
    expect(result.skipped.map((s) => s.path)).toEqual(["bad.stub"])
    expect(result.undeclaredVocab.map((o) => o.file)).toEqual(["a.stub", "c.stub"])
  })
})

describe("VocabCheck", () => {
  it.each([
    true,
    false,
  ])("lets a registry failure that is not about vocabulary through when strict is %s", (strict) => {
    const registry: VocabRegistry = {
      ...noopRegistry,
      assertEffectDeclared: () => {
        throw new Error("registry broke")
      },
    }
    const check = new VocabCheck(registry, strict)
    expect(() =>
      check.effect({
        value: "x-acme:ping",
        plugin: "effects-acme",
        file: "a.stub",
        line: 4,
        symbol: "s",
      }),
    ).toThrow("registry broke")
    expect(check.occurrences).toEqual([])
  })
})
