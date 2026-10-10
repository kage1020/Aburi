import type { ScanResult } from "@aburi/core"
import { IR_SCHEMA_URL } from "@aburi/test-harness"
import { irSchemaViolations } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { beforeAll, describe, expect, it } from "vitest"
import { scanFixture, useFixtureCheckout } from "./project"

// Nothing here mutates the fixture, so one checkout and one scan serve every assertion.
const fixture = useFixtureCheckout("nestjs-billing", "all")

let result: ScanResult
let ir: IR

beforeAll(async () => {
  result = await scanFixture(fixture.root)
  ir = result.ir
})

const SYMBOL_ID = /^[a-z][a-z0-9]*:[^#]+#.+$/

describe("e2e: scan on fixtures/nestjs-billing — what it reads", () => {
  it("parses every source file and skips none", () => {
    expect(ir.stats.totalFiles).toBe(10)
    expect(ir.stats.parsedFiles).toBe(10)
    expect(result.parseErrors).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it("emits well-shaped via:call edges when the resolver produces any", () => {
    for (const edge of ir.dependencies.filter((d) => d.via === "call")) {
      expect(edge.from).toMatch(SYMBOL_ID)
      expect(edge.to).toMatch(SYMBOL_ID)
      expect(edge.direction).toBe("outbound")
      expect(edge.effect).toBeNull()
    }
  })

  it("classifies the NestJS controllers, and gives every route a boundary decorator", () => {
    const controllers = ir.symbols.filter((s) => s.extKind === "framework:nestjs:controller")
    expect(controllers.map((c) => c.name).sort()).toEqual([
      "BillingController",
      "CustomersController",
    ])

    const routes = ir.symbols.filter((s) => s.extKind === "framework:nestjs:route")
    // BillingController: create / read / send. CustomersController: create / read / list.
    expect(routes).toHaveLength(6)
    for (const route of routes) {
      expect(
        route.decorators.find((d) => d.boundary),
        `route ${route.id}`,
      ).toBeDefined()
    }
  })

  it("classifies the @Injectable services as providers and keeps their methods", () => {
    const providers = ir.symbols.filter((s) => s.extKind === "framework:nestjs:provider")
    expect(providers.map((p) => p.name).sort()).toEqual([
      "BillingService",
      "CustomersService",
      "LoggerService",
    ])

    const billingMethods = ir.symbols.filter(
      (s) => s.kind === "method" && s.source.file.endsWith("billing/billing.service.ts"),
    )
    expect(billingMethods.length).toBeGreaterThanOrEqual(12)
    expect(billingMethods.filter((s) => s.dropped)).toEqual([])
  })

  it("classifies the NestJS modules", () => {
    const modules = ir.symbols.filter((s) => s.extKind === "framework:nestjs:module")
    expect(modules.map((m) => m.name).sort()).toEqual([
      "AppModule",
      "BillingModule",
      "CustomersModule",
    ])
  })
})

describe("e2e: scan on fixtures/nestjs-billing — the document it writes", () => {
  it("validates against the IR schema it names", () => {
    expect(ir.$schema).toBe(IR_SCHEMA_URL)
    expect(irSchemaViolations(ir)).toEqual([])
  })

  it("reports LanguageIds, not plugin manifest names, and every Symbol's among them", () => {
    expect(ir.workspace.languages).toEqual(["ts"])
    expect(new Set(ir.symbols.map((symbol) => symbol.language))).toEqual(new Set(["ts"]))
  })

  it("lets a Decorator carry a qualifier, and refuses an empty or null one", () => {
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
    expect(irSchemaViolations(withQualifier(""))).not.toEqual([])
    expect(irSchemaViolations(withQualifier(null))).not.toEqual([])
  })

  it("lets an input carry bindings, and refuses an empty list or an empty name", () => {
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
    expect(irSchemaViolations(withBindings([]))).not.toEqual([])
    expect(irSchemaViolations(withBindings([""]))).not.toEqual([])
  })
})
