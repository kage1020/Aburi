import type { ScanResult } from "@aburi/core"
import { beforeAll, describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { IR_SCHEMA, scanFixture } from "../src/scan-helper"

// Nothing here mutates the fixture, so one checkout and one scan serve every assertion.
const fixture = useFixtureCheckout("nestjs-billing", "all")

let result: ScanResult

beforeAll(async () => {
  result = await scanFixture(fixture.root)
})

describe("e2e: scan on fixtures/nestjs-billing", () => {
  it("passes every integrity invariant and emits the schema-pinned IR", () => {
    // scan() throws on any integrity violation, so reaching here means every invariant
    // passed for the whole billing fixture.
    expect(result.ir.$schema).toBe(IR_SCHEMA)
    expect(result.parseErrors).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it("emits well-shaped via:call edges when the resolver produces any (untyped tier ⇒ may be zero)", () => {
    // The fixture is dominated by `this.<service>.<method>()` — the `call-resolution.md`
    // "runtime receivers" the untyped tier cannot resolve — so zero call edges is the expected
    // outcome. What is asserted is the shape contract on any edge that is emitted; positive
    // file-scope / import-scope resolution lives in core-scan.test.ts.
    const callEdges = result.ir.dependencies.filter((d) => d.via === "call")
    for (const edge of callEdges) {
      expect(edge.from).toMatch(/^[a-z][a-z0-9]*:[^#]+#.+$/)
      expect(edge.to).toMatch(/^[a-z][a-z0-9]*:[^#]+#.+$/)
      expect(edge.direction).toBe("outbound")
      expect(edge.effect).toBeNull()
    }
  })

  it("recognises every fixture source file and none get skipped", () => {
    // 10 handwritten .ts files under src/. The concrete integer catches discoverFiles'
    // ignore rules starting to drop something they should not.
    expect(result.ir.stats.totalFiles).toBe(10)
    expect(result.ir.stats.parsedFiles).toBe(10)
  })

  it("classifies NestJS controllers as framework:nestjs:controller with boundary routes", () => {
    const controllers = result.ir.symbols.filter((s) => s.extKind === "framework:nestjs:controller")
    expect(controllers.map((c) => c.name).sort()).toEqual([
      "BillingController",
      "CustomersController",
    ])

    const routes = result.ir.symbols.filter((s) => s.extKind === "framework:nestjs:route")
    // BillingController: create / read / send. CustomersController: create / read / list.
    expect(routes.length).toBe(6)
    // Every route must carry `boundary: true` — the reason drop-b exempts them from the
    // "dropped" list.
    for (const route of routes) {
      const routeDecorator = route.decorators.find((d) => d.boundary)
      expect(routeDecorator, `route ${route.id} is missing a boundary decorator`).toBeDefined()
    }
  })

  it("classifies @Injectable services as framework:nestjs:provider and keeps their methods", () => {
    const providers = result.ir.symbols.filter((s) => s.extKind === "framework:nestjs:provider")
    expect(providers.map((p) => p.name).sort()).toEqual([
      "BillingService",
      "CustomersService",
      "LoggerService",
    ])

    // BillingService has 12 methods, every one with a real body, so none is dropped in the
    // base state — this is what scenario B mutates against.
    const billingMethods = result.ir.symbols.filter(
      (s) => s.kind === "method" && s.source.file.endsWith("billing/billing.service.ts"),
    )
    expect(billingMethods.length).toBeGreaterThanOrEqual(12)
    expect(
      billingMethods.filter((s) => s.dropped),
      "no BillingService method should be dropped in the base state",
    ).toEqual([])
  })

  it("emits nestjs modules with framework:nestjs:module extKind", () => {
    const modules = result.ir.symbols.filter((s) => s.extKind === "framework:nestjs:module")
    expect(modules.map((m) => m.name).sort()).toEqual([
      "AppModule",
      "BillingModule",
      "CustomersModule",
    ])
  })
})
