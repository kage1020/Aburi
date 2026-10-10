import type { ScanResult } from "@aburi/core"
import { irSchemaViolations } from "@aburi/test-support"
import { beforeAll, describe, expect, it } from "vitest"
import { scanFixture, useFixtureCheckout } from "./project"

const fixture = useFixtureCheckout("nestjs-billing", "all")

let ir: ScanResult["ir"]

beforeAll(async () => {
  ir = (await scanFixture(fixture.root)).ir
})

describe("e2e: emitted IR validates against schema/aburi.ir.v1.json", () => {
  it("passes ajv for the nestjs-billing fixture", () => {
    expect(irSchemaViolations(ir)).toEqual([])
  })

  it("reports LanguageIds — not plugin manifest names — in workspace.languages", () => {
    expect(ir.workspace.languages).toEqual(["ts"])
    for (const id of ir.workspace.languages) expect(id).toMatch(/^[a-z][a-z0-9]*$/)
  })

  it("accepts a Decorator carrying a qualifier, and rejects the shapes Class B forbids", () => {
    const decorated = ir.symbols.find((symbol) => symbol.decorators.length > 0)
    expect(decorated).toBeDefined()
    const withQualifier = (qualifier: unknown) => ({
      ...ir,
      symbols: ir.symbols.map((symbol) =>
        symbol === decorated
          ? {
              ...symbol,
              decorators: symbol.decorators.map((d, i) => (i === 0 ? { ...d, qualifier } : d)),
            }
          : symbol,
      ),
    })

    expect(irSchemaViolations(withQualifier("nest"))).toEqual([])
    expect(irSchemaViolations(withQualifier("")).length).toBeGreaterThan(0)
    expect(irSchemaViolations(withQualifier(null)).length).toBeGreaterThan(0)
  })

  it("accepts an input carrying bindings, and rejects the shapes Class B forbids", () => {
    const host = ir.symbols.find((symbol) => (symbol.signature?.inputs.length ?? 0) > 0)
    expect(host).toBeDefined()
    const withBindings = (bindings: unknown) => ({
      ...ir,
      symbols: ir.symbols.map((symbol) =>
        symbol === host && symbol.signature
          ? {
              ...symbol,
              signature: {
                ...symbol.signature,
                inputs: symbol.signature.inputs.map((input, i) =>
                  i === 0 ? { ...input, bindings } : input,
                ),
              },
            }
          : symbol,
      ),
    })

    expect(irSchemaViolations(withBindings(["save"]))).toEqual([])
    expect(irSchemaViolations(withBindings([])).length).toBeGreaterThan(0)
    expect(irSchemaViolations(withBindings([""])).length).toBeGreaterThan(0)
  })

  it("keeps every Symbol.language inside workspace.languages", () => {
    const declared = new Set<string>(ir.workspace.languages)
    const used = new Set(ir.symbols.map((symbol) => symbol.language))
    expect(used.size).toBeGreaterThan(0)
    for (const language of used) expect(declared.has(language)).toBe(true)
  })
})
