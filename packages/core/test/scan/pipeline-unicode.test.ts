import { makeCall, sig } from "@aburi/test-support"
import type { CallCandidate, ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { ExtractedFile } from "../../src"
import {
  extractOneSymbol,
  type OneSymbolFile,
  runPipeline,
  stubCandidate,
  stubEffectsPlugin,
  stubLanguagePlugin,
} from "../fixtures/plugins"

const decomposed = "café".normalize("NFD")
const composed = decomposed.normalize("NFC")

const emitting = stubEffectsPlugin("effects-loud", () => ({
  effectId: "event.publish",
  confidence: "high",
  derivedBy: "effects-loud:hit",
}))

function importing(spelling: string): ImportEdge {
  return {
    source: `./${spelling}`,
    symbols: [`${spelling} as ${spelling}Local`],
    namespaceBinding: spelling,
    line: 1,
    dynamic: false,
  }
}

function bareDecorator(name: string) {
  return { name, raw: `@${decomposed}()`, arguments: [], boundary: false, line: 1 }
}

type Row = [string, OneSymbolFile, (file: ExtractedFile) => unknown, unknown]

describe("runFilePipeline — Unicode normalization at the plugin boundary", () => {
  it("uses a genuinely decomposed fixture, so the cases below are not vacuous", () => {
    expect([...decomposed].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0x65, 0x301])
    expect([...composed].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0xe9])
  })

  it.each<Row>([
    [
      "source.file",
      {
        candidate: stubCandidate("Fn", {
          source: { ...stubCandidate("Fn").source, file: `${decomposed}.stub` },
        }),
      },
      (file) => file.symbols[0]?.source.file,
      `${composed}.stub`,
    ],
    [
      "signature.inputs[].name and .bindings",
      {
        candidate: stubCandidate("Fn", {
          signature: sig({
            inputs: [
              { name: `{ ${decomposed} }`, type: "", bindings: ["a", decomposed] },
              { name: decomposed, type: "" },
            ],
          }),
        }),
      },
      (file) => file.symbols[0]?.signature?.inputs,
      [
        { name: `{ ${composed} }`, type: "", bindings: ["a", composed] },
        { name: composed, type: "" },
      ],
    ],
    [
      "decorators[].name, adding no qualifier key to a bare one",
      { candidate: stubCandidate("Fn", { decorators: [bareDecorator(decomposed)] }) },
      (file) => file.symbols[0]?.decorators,
      [{ ...bareDecorator(composed) }],
    ],
    [
      "decorators[].qualifier",
      {
        candidate: stubCandidate("Fn", {
          decorators: [{ ...bareDecorator("Controller"), qualifier: decomposed }],
        }),
      },
      (file) => file.symbols[0]?.decorators.map((d) => d.qualifier),
      [composed],
    ],
    [
      "an unclassified call target",
      { body: { rules: [], calls: [makeCall({ target: `${decomposed}.doWork` })] } },
      (file) => file.symbols[0]?.calls.map((c) => c.target),
      [`${composed}.doWork`],
    ],
    [
      "a classified effect target",
      {
        effects: [emitting],
        body: { rules: [], calls: [makeCall({ target: `${decomposed}.emit` })] },
      },
      (file) => file.symbols[0]?.effects.map((e) => e.target),
      [`${composed}.emit`],
    ],
    [
      "the import edges",
      { imports: [importing(decomposed)] },
      (file) => file.imports,
      [importing(composed)],
    ],
  ])("normalizes %s", async (_field, setup, read, expected) => {
    expect(read(await extractOneSymbol(setup))).toStrictEqual(expected)
  })

  it.each<Row>([
    [
      "decorators[].raw",
      { candidate: stubCandidate("Fn", { decorators: [bareDecorator(decomposed)] }) },
      (file) => file.symbols[0]?.decorators[0]?.raw,
      `@${decomposed}()`,
    ],
    [
      "the signature's type strings",
      {
        candidate: stubCandidate("Fn", {
          signature: sig({ inputs: [{ name: "x", type: decomposed }], outputs: [decomposed] }),
        }),
      },
      (file) => [file.symbols[0]?.signature?.inputs[0]?.type, file.symbols[0]?.signature?.outputs],
      [decomposed, [decomposed]],
    ],
    [
      "the Symbol id, for the integrity check to judge",
      { candidate: stubCandidate("Fn", { id: `stub:test.stub#${decomposed}` }) },
      (file) => file.symbols[0]?.id,
      `stub:test.stub#${decomposed}`,
    ],
  ])("leaves %s as the plugin wrote it", async (_field, setup, read, expected) => {
    expect(read(await extractOneSymbol(setup))).toStrictEqual(expected)
  })

  it("normalizes the import edges of a file the parse refused, too", async () => {
    const result = await runPipeline({
      language: stubLanguagePlugin({
        parseFile: async () => ({ tree: null, errors: [], imports: [importing(decomposed)] }),
      }),
    })
    expect(result).toMatchObject({ kind: "parse-failed", imports: [importing(composed)] })
  })

  it("hands every classifier the normalized target", async () => {
    const seen: string[] = []
    await extractOneSymbol({
      effects: [
        stubEffectsPlugin("effects-watch", (call) => {
          seen.push(call.target)
          return null
        }),
      ],
      body: { rules: [], calls: [makeCall({ target: `${decomposed}.emit` })] },
    })
    expect(seen).toEqual([`${composed}.emit`])
  })

  it("hands a classifier the plugin's own call when nothing needed normalizing", async () => {
    const seen: CallCandidate[] = []
    const call = makeCall({ target: "helper.doWork" })
    await extractOneSymbol({
      effects: [
        stubEffectsPlugin("effects-watch", (handed) => {
          seen.push(handed)
          return null
        }),
      ],
      body: { rules: [], calls: [call] },
    })
    expect(seen[0]).toBe(call)
  })
})
