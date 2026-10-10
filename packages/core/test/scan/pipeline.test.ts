import { noopRegistry, silentLogger } from "@aburi/test-support"
import type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  FrameworkPlugin,
  ImportEdge,
  LanguagePlugin,
  OpaqueAstNode,
  ParseResult,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDropCFilter, type ExtractedFile, runFilePipeline, VocabCheck } from "../../src"
import { symbolId } from "../fixtures/ir"
import {
  effectsManifest,
  frameworkManifest,
  stubCandidate,
  stubFile,
  stubLanguagePlugin,
} from "../fixtures/plugins"

function singleSymbolPlugin(options: {
  candidate: SymbolCandidate<OpaqueAstNode>
  body: BodyExtraction
  normalized?: string
  imports?: readonly ImportEdge[]
}): LanguagePlugin {
  return stubLanguagePlugin({
    parseFile: async (): Promise<ParseResult> => ({
      tree: {} as OpaqueAstNode,
      errors: [],
      imports: [...(options.imports ?? [])],
    }),
    extractSymbols: () => [options.candidate],
    walkBody: () => options.body,
    normalizeAst: () => options.normalized ?? "stub-ast",
  })
}

function baseCandidate(): SymbolCandidate<OpaqueAstNode> {
  return stubCandidate("Fn", {
    decorators: [
      { name: "Controller", raw: "@Controller()", arguments: [], boundary: false, line: 1 },
    ],
    source: { file: "test.stub", startLine: 1, endLine: 5, startColumn: null, endColumn: null },
  })
}

function stubCall(target: string, line = 1): CallCandidate {
  return { target, line, argumentCount: 0, inAwait: false, inNew: false, literalArgs: [] }
}

async function runPipelineWithStubs(overrides: {
  frameworks?: readonly FrameworkPlugin[]
  effects?: readonly EffectPlugin[]
  candidate?: SymbolCandidate<OpaqueAstNode>
  body?: BodyExtraction
  imports?: readonly ImportEdge[]
}): Promise<ExtractedFile> {
  const candidate = overrides.candidate ?? baseCandidate()
  const body: BodyExtraction = overrides.body ?? { rules: [], calls: [] }
  const language = singleSymbolPlugin({ candidate, body, imports: overrides.imports ?? [] })
  const result = await runFilePipeline({
    file: stubFile,
    language,
    frameworks: overrides.frameworks ?? [],
    effects: overrides.effects ?? [],
    registry: noopRegistry,
    vocab: new VocabCheck(noopRegistry, true),
    config: {},
    dropCFilter: buildDropCFilter(),
    component: null,
    treeReleaseFailures: [],
    log: silentLogger,
  })
  if (result.kind !== "extracted") {
    throw new Error(`stub fixture produced a ${result.kind} file, not an extracted one`)
  }
  return result
}

describe("runFilePipeline — framework classifySymbol dispatch", () => {
  it("uses the first framework that returns a non-null classification (first-match-wins)", async () => {
    const fw1: FrameworkPlugin = {
      manifest: frameworkManifest("framework-first"),
      init: async () => {},
      classifySymbol: (): SymbolClassification | null => ({
        extKind: "framework:first:role",
        derivedBy: "framework-first:hit",
      }),
    }
    const fw2Calls: number[] = []
    const fw2: FrameworkPlugin = {
      manifest: frameworkManifest("framework-second"),
      init: async () => {},
      classifySymbol: (): SymbolClassification | null => {
        fw2Calls.push(1)
        return { extKind: "framework:second:role", derivedBy: "framework-second:hit" }
      },
    }

    const result = await runPipelineWithStubs({ frameworks: [fw1, fw2] })

    const symbol = result.symbols[0]
    expect(symbol?.extKind).toBe("framework:first:role")
    expect(symbol?.derivedBy).toContain("framework-first:hit")
    expect(fw2Calls).toEqual([])
  })

  it("hands the file's import edges to the classifier alongside the candidate", async () => {
    const seen: (readonly ImportEdge[])[] = []
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-imports"),
      init: async () => {},
      classifySymbol: (_symbol, ctx): SymbolClassification | null => {
        seen.push(ctx.imports)
        return null
      },
    }
    const imports: ImportEdge[] = [
      { source: "@nestjs/common", symbols: ["Controller as Ctrl"], line: 1, dynamic: false },
    ]

    const result = await runPipelineWithStubs({ frameworks: [fw], imports })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(result.imports)
  })

  it("falls through to the next framework when the first returns null", async () => {
    const fw1: FrameworkPlugin = {
      manifest: frameworkManifest("framework-null"),
      init: async () => {},
      classifySymbol: () => null,
    }
    const fw2: FrameworkPlugin = {
      manifest: frameworkManifest("framework-hit"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:hit:role",
        derivedBy: "framework-hit:hit",
      }),
    }

    const result = await runPipelineWithStubs({ frameworks: [fw1, fw2] })
    expect(result.symbols[0]?.extKind).toBe("framework:hit:role")
  })

  it("applies decoratorBoundaries overrides from the winning framework result", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-boundary"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:hit:controller",
        decoratorBoundaries: { Controller: true },
        derivedBy: "framework-boundary:hit",
      }),
    }

    const result = await runPipelineWithStubs({ frameworks: [fw] })
    const decorator = result.symbols[0]?.decorators.find((d) => d.name === "Controller")
    expect(decorator?.boundary).toBe(true)
  })

  it("splits the framework derivedBy value on `;` so multi-signal reasons flatten into the array", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-compound"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:next:page",
        derivedBy: "framework:next:page;framework:next:client-component",
      }),
    }

    const result = await runPipelineWithStubs({ frameworks: [fw] })
    const derivedBy = result.symbols[0]?.derivedBy ?? []
    expect(derivedBy).toContain("framework:next:page")
    expect(derivedBy).toContain("framework:next:client-component")
  })

  it("propagates SymbolClassification.confidence to the emitted Symbol", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-med"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:express:middleware",
        derivedBy: "framework:express:middleware:app.use",
        confidence: "medium",
      }),
    }

    const result = await runPipelineWithStubs({ frameworks: [fw] })
    expect(result.symbols[0]?.confidence).toBe("medium")
  })

  it("defaults Symbol.confidence to 'high' when no framework classifies", async () => {
    const result = await runPipelineWithStubs({ frameworks: [] })
    expect(result.symbols[0]?.confidence).toBe("high")
  })

  it("defaults Symbol.confidence to 'high' when the winning classifier omits confidence", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-no-conf"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:nestjs:controller",
        derivedBy: "framework:nestjs:controller:Controller",
        // confidence intentionally omitted — pre-existing plugins (react/next/nestjs) don't set it
      }),
    }
    const result = await runPipelineWithStubs({ frameworks: [fw] })
    expect(result.symbols[0]?.confidence).toBe("high")
  })
})

describe("runFilePipeline — framework symbolDropHint", () => {
  it("asks a framework that did not classify the Symbol, and shows it the winning classification", async () => {
    const classifier: FrameworkPlugin = {
      manifest: frameworkManifest("framework-classifier"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:first:role",
        derivedBy: "framework-first:hit",
      }),
    }
    const seen: (string | null)[] = []
    const dropper: FrameworkPlugin = {
      manifest: frameworkManifest("framework-dropper"),
      init: async () => {},
      classifySymbol: () => null,
      symbolDropHint: (symbol) => {
        seen.push(symbol.extKind)
        return { reason: "dropper says so", category: "B" }
      },
    }

    const result = await runPipelineWithStubs({ frameworks: [classifier, dropper] })

    expect(seen).toEqual(["framework:first:role"])
    expect(result.symbols[0]?.dropped).toBe(true)
    expect(result.symbols[0]?.dropReason).toBe("dropper says so")
  })

  it("takes the first framework's drop reason, in list order", async () => {
    const dropping = (name: string): FrameworkPlugin => ({
      manifest: frameworkManifest(name),
      init: async () => {},
      classifySymbol: () => null,
      symbolDropHint: () => ({ reason: name, category: "B" }),
    })

    const result = await runPipelineWithStubs({
      frameworks: [dropping("framework-a"), dropping("framework-b")],
    })

    expect(result.symbols[0]?.dropReason).toBe("framework-a")
  })

  it("keeps the Symbol when every framework's hint is null", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-keeps"),
      init: async () => {},
      classifySymbol: () => null,
      symbolDropHint: () => null,
    }

    const result = await runPipelineWithStubs({ frameworks: [fw] })

    expect(result.symbols[0]?.dropped).toBe(false)
  })
})

describe("runFilePipeline — effect classify dispatch", () => {
  it("stops at the first effect that classifies the call (first-non-null-wins)", async () => {
    const secondCalls: string[] = []
    const eff1: EffectPlugin = {
      manifest: effectsManifest("effects-first"),
      init: async () => {},
      classify: (call: CallCandidate): EffectClassification | null => ({
        effectId: "db.read",
        confidence: "high",
        derivedBy: `effects-first:${call.target}`,
      }),
    }
    const eff2: EffectPlugin = {
      manifest: effectsManifest("effects-second"),
      init: async () => {},
      classify: (call: CallCandidate) => {
        secondCalls.push(call.target)
        return null
      },
    }

    const result = await runPipelineWithStubs({
      effects: [eff1, eff2],
      body: { rules: [], calls: [stubCall("prisma.user.findMany")] },
    })

    expect(result.symbols[0]?.effects.map((e) => e.plugin)).toEqual(["effects-first"])
    expect(secondCalls).toEqual([])
  })

  it("falls through to the next effect plugin when the first returns null", async () => {
    const eff1: EffectPlugin = {
      manifest: effectsManifest("effects-first"),
      init: async () => {},
      classify: () => null,
    }
    const eff2: EffectPlugin = {
      manifest: effectsManifest("effects-second"),
      init: async () => {},
      classify: (): EffectClassification => ({
        effectId: "db.write",
        confidence: "medium",
        derivedBy: "effects-second:hit",
      }),
    }

    const result = await runPipelineWithStubs({
      effects: [eff1, eff2],
      body: { rules: [], calls: [stubCall("something.update")] },
    })

    expect(result.symbols[0]?.effects[0]?.plugin).toBe("effects-second")
    expect(result.symbols[0]?.effects[0]?.id).toBe("db.write")
  })

  it("hands the effect plugin each owner decorator's receiver, and none for a bare one", async () => {
    const seen: ClassifyContext["owner"]["decorators"][] = []
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-owner"),
      init: async () => {},
      classify: (_call: CallCandidate, ctx: ClassifyContext) => {
        seen.push(ctx.owner.decorators)
        return null
      },
    }
    const candidate = stubCandidate("Fn", {
      decorators: [
        {
          name: "Post",
          qualifier: "tsed",
          raw: "@tsed.Post()",
          arguments: [],
          boundary: false,
          line: 1,
        },
        { name: "Get", raw: "@Get()", arguments: [], boundary: false, line: 2 },
      ],
      source: { file: "test.stub", startLine: 1, endLine: 5, startColumn: null, endColumn: null },
    })

    await runPipelineWithStubs({
      effects: [eff],
      candidate,
      body: { rules: [], calls: [stubCall("db.save")] },
    })

    // Strict, so the bare one must have no `qualifier` key at all, not one holding `undefined`.
    expect(seen).toStrictEqual([
      [
        { name: "Post", qualifier: "tsed", boundary: false },
        { name: "Get", boundary: false },
      ],
    ])
  })

  it("hands the effect plugin a boundary a framework plugin keyed on the qualified decorator", async () => {
    const seen: ClassifyContext["owner"]["decorators"][] = []
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-qualified"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:tsed:route",
        decoratorBoundaries: { "tsed.Post": true },
        derivedBy: "framework-qualified:hit",
      }),
    }
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-owner"),
      init: async () => {},
      classify: (_call: CallCandidate, ctx: ClassifyContext) => {
        seen.push(ctx.owner.decorators)
        return null
      },
    }
    const candidate = stubCandidate("Fn", {
      decorators: [
        {
          name: "Post",
          qualifier: "tsed",
          raw: "@tsed.Post()",
          arguments: [],
          boundary: false,
          line: 1,
        },
      ],
      source: { file: "test.stub", startLine: 1, endLine: 5, startColumn: null, endColumn: null },
    })

    await runPipelineWithStubs({
      frameworks: [fw],
      effects: [eff],
      candidate,
      body: { rules: [], calls: [stubCall("db.save")] },
    })

    expect(seen).toStrictEqual([[{ name: "Post", qualifier: "tsed", boundary: true }]])
  })

  it("leaves unclassified calls in Symbol.calls[] with resolved:null", async () => {
    const result = await runPipelineWithStubs({
      effects: [],
      body: { rules: [], calls: [stubCall("helper.doWork")] },
    })
    expect(result.symbols[0]?.calls).toEqual([{ target: "helper.doWork", line: 1, resolved: null }])
  })
})

describe("runFilePipeline — array line ordering", () => {
  it("sorts calls[] by line even when the language plugin visits body children out of source order", async () => {
    const result = await runPipelineWithStubs({
      effects: [],
      body: {
        rules: [],
        calls: [stubCall("zeta.doWork", 20), stubCall("alpha.doWork", 40)],
      },
    })
    const lines = result.symbols[0]?.calls.map((c) => c.line) ?? []
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
  })

  it("sorts effects[] by line — regression guard for the sibling of the calls sort bug", async () => {
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-loud"),
      init: async () => {},
      classify: (call: CallCandidate): EffectClassification => ({
        effectId: "event.publish",
        confidence: "high",
        derivedBy: `effects-loud:${call.target}`,
      }),
    }
    const result = await runPipelineWithStubs({
      effects: [eff],
      body: {
        rules: [],
        calls: [stubCall("zeta.emit", 15), stubCall("alpha.emit", 60)],
      },
    })
    const lines = result.symbols[0]?.effects.map((e) => e.line) ?? []
    expect(lines).toEqual([15, 60])
  })

  it("sorts decorators[] by line when the language plugin emits them out of order", async () => {
    const candidate: SymbolCandidate<OpaqueAstNode> = {
      ...baseCandidate(),
      decorators: [
        { name: "Later", raw: "@Later()", arguments: [], boundary: false, line: 30 },
        { name: "Earlier", raw: "@Earlier()", arguments: [], boundary: false, line: 5 },
      ],
    }
    const result = await runPipelineWithStubs({ candidate })
    const lines = result.symbols[0]?.decorators.map((d) => d.line) ?? []
    expect(lines).toEqual([5, 30])
  })

  it("preserves the relative order of same-line entries (stable sort)", async () => {
    const result = await runPipelineWithStubs({
      effects: [],
      body: {
        rules: [],
        calls: [stubCall("first.hit", 10), stubCall("second.hit", 10), stubCall("third.hit", 10)],
      },
    })
    const targets = result.symbols[0]?.calls.map((c) => c.target) ?? []
    expect(targets).toEqual(["first.hit", "second.hit", "third.hit"])
  })
})

describe("runFilePipeline — rule strings at the plugin boundary", () => {
  it("writes a plugin's long, multi-line rule strings in their normalized, truncated form", async () => {
    const long = "x".repeat(200)
    const result = await runPipelineWithStubs({
      body: {
        rules: [
          {
            type: "guard",
            line: 3,
            condition: `a ||\n    ${long}`,
            what: null,
            expr: null,
            loopKind: null,
          },
          {
            type: "throw",
            line: 4,
            condition: null,
            what: "make({\n  code })",
            expr: null,
            loopKind: null,
          },
        ],
        calls: [],
      },
    })
    const rules = result.symbols[0]?.rules ?? []
    expect(rules.map((r) => [r.condition, r.what])).toEqual([
      [`a || ${"x".repeat(115)}...`, null],
      [null, "make({ code })"],
    ])
  })
})

describe("runFilePipeline — Symbol id contract", () => {
  it("throws when the language plugin emits a Symbol id without a language prefix", async () => {
    const bogusCandidate = { ...baseCandidate(), id: symbolId("no-colon-here") }
    await expect(runPipelineWithStubs({ candidate: bogusCandidate })).rejects.toThrow(
      /language prefix/,
    )
  })
})

describe("runFilePipeline — Unicode normalization at the plugin boundary", () => {
  const decomposed = "café".normalize("NFD")
  const composed = decomposed.normalize("NFC")

  it("uses a genuinely decomposed fixture, so the cases below are not vacuous", () => {
    expect([...decomposed].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0x65, 0x301])
    expect([...composed].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0xe9])
  })

  it("normalizes source.file, which the integrity check and the call resolver both read", async () => {
    const candidate = {
      ...baseCandidate(),
      source: { ...baseCandidate().source, file: `${decomposed}.stub` },
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.source.file).toBe(`${composed}.stub`)
  })

  it("normalizes signature.inputs[].name, which the local-shadow guard compares", async () => {
    const candidate = {
      ...baseCandidate(),
      signature: {
        inputs: [{ name: decomposed, type: "string" }],
        outputs: [],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.signature?.inputs.map((i) => i.name)).toEqual([composed])
  })

  it("normalizes signature.inputs[].bindings, the names a destructuring parameter shadows", async () => {
    const candidate = {
      ...baseCandidate(),
      signature: {
        inputs: [{ name: `{ ${decomposed} }`, type: "", bindings: ["a", decomposed] }],
        outputs: [],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.signature?.inputs).toStrictEqual([
      { name: `{ ${composed} }`, type: "", bindings: ["a", composed] },
    ])
  })

  it("leaves a single-name parameter without bindings", async () => {
    const candidate = {
      ...baseCandidate(),
      signature: {
        inputs: [{ name: decomposed, type: "" }],
        outputs: [],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.signature?.inputs).toStrictEqual([{ name: composed, type: "" }])
  })

  it("normalizes decorators[].name, which a framework plugin matches against the edges", async () => {
    const candidate = {
      ...baseCandidate(),
      decorators: [
        { name: decomposed, raw: `@${decomposed}()`, arguments: [], boundary: false, line: 1 },
      ],
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.decorators.map((d) => d.name)).toEqual([composed])
  })

  it("normalizes decorators[].qualifier, which is matched against the namespace binding", async () => {
    const candidate = {
      ...baseCandidate(),
      decorators: [
        {
          name: "Controller",
          qualifier: decomposed,
          raw: `@${decomposed}.Controller()`,
          arguments: [],
          boundary: false,
          line: 1,
        },
      ],
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.decorators.map((d) => d.qualifier)).toEqual([composed])
  })

  it("leaves a bare decorator without a qualifier key at all", async () => {
    const candidate = {
      ...baseCandidate(),
      decorators: [
        { name: decomposed, raw: `@${decomposed}()`, arguments: [], boundary: false, line: 1 },
      ],
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.decorators).toStrictEqual([
      { name: composed, raw: `@${decomposed}()`, arguments: [], boundary: false, line: 1 },
    ])
  })

  it("leaves decorators[].raw alone, because it is a quotation of source", async () => {
    const candidate = {
      ...baseCandidate(),
      decorators: [
        { name: decomposed, raw: `@${decomposed}()`, arguments: [], boundary: false, line: 1 },
      ],
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.decorators[0]?.raw).toBe(`@${decomposed}()`)
  })

  it("leaves the signature type strings alone, because they are quotations of source", async () => {
    const candidate = {
      ...baseCandidate(),
      signature: {
        inputs: [{ name: "x", type: decomposed }],
        outputs: [decomposed],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.signature?.inputs[0]?.type).toBe(decomposed)
    expect(result.symbols[0]?.signature?.outputs).toEqual([decomposed])
  })

  it("normalizes an unclassified call target", async () => {
    const result = await runPipelineWithStubs({
      body: { rules: [], calls: [stubCall(`${decomposed}.doWork`, 1)] },
    })
    expect(result.symbols[0]?.calls.map((c) => c.target)).toEqual([`${composed}.doWork`])
  })

  it("normalizes a classified effect target, which is a sort key once propagated", async () => {
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-loud"),
      init: async () => {},
      classify: (): EffectClassification => ({
        effectId: "event.publish",
        confidence: "high",
        derivedBy: "effects-loud:hit",
      }),
    }
    const result = await runPipelineWithStubs({
      effects: [eff],
      body: { rules: [], calls: [stubCall(`${decomposed}.emit`, 1)] },
    })
    expect(result.symbols[0]?.effects.map((e) => e.target)).toEqual([`${composed}.emit`])
  })

  it("hands the effect plugin the normalized target, so one spelling reaches every classifier", async () => {
    const seen: string[] = []
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-watch"),
      init: async () => {},
      classify: (call: CallCandidate): EffectClassification | null => {
        seen.push(call.target)
        return null
      },
    }
    await runPipelineWithStubs({
      effects: [eff],
      body: { rules: [], calls: [stubCall(`${decomposed}.emit`, 1)] },
    })
    expect(seen).toEqual([`${composed}.emit`])
  })

  it("normalizes the import edges the call resolver matches against", async () => {
    const result = await runPipelineWithStubs({
      imports: [
        {
          source: `./${decomposed}`,
          symbols: [`${decomposed} as ${decomposed}Local`],
          namespaceBinding: decomposed,
          line: 1,
          dynamic: false,
        },
      ],
    })
    expect(result.imports).toEqual([
      {
        source: `./${composed}`,
        symbols: [`${composed} as ${composed}Local`],
        namespaceBinding: composed,
        line: 1,
        dynamic: false,
      },
    ])
  })

  it("returns the candidate and the call untouched when nothing needs normalizing", async () => {
    const candidate = baseCandidate()
    const seen: CallCandidate[] = []
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-watch"),
      init: async () => {},
      classify: (call: CallCandidate): EffectClassification | null => {
        seen.push(call)
        return null
      },
    }
    const call = stubCall("helper.doWork", 1)
    await runPipelineWithStubs({ candidate, effects: [eff], body: { rules: [], calls: [call] } })
    expect(seen[0]).toBe(call)
  })
})
