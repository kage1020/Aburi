import type { CallCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDropCFilter } from "../../src"

function call(target: string): CallCandidate {
  return { target, line: 1, argumentCount: 0, inAwait: false, inNew: false, literalArgs: [] }
}

describe("buildDropCFilter — Unicode normalization (ir-schema.md)", () => {
  const decomposed = "café".normalize("NFD")
  const composed = decomposed.normalize("NFC")

  it("matches a decomposed suppress prefix against a normalized target", () => {
    const filter = buildDropCFilter({ suppress: [decomposed] })
    expect(filter.shouldDropCall(call(`${composed}.log`))).toBe(true)
  })

  it("matches a decomposed plugin dropCallee against a normalized target", () => {
    const filter = buildDropCFilter({ pluginDropCallees: [decomposed] })
    expect(filter.shouldDropCall(call(`${composed}.log`))).toBe(true)
  })

  it("lets a decomposed keep prefix rescue a call the suppress list claims", () => {
    const filter = buildDropCFilter({ suppress: [composed], keep: [`${decomposed}.audit`] })
    expect(filter.shouldDropCall(call(`${composed}.audit`))).toBe(false)
    expect(filter.shouldDropCall(call(`${composed}.debug`))).toBe(true)
  })
})
