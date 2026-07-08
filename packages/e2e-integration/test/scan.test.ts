import { afterEach, describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { scanFixture } from "../src/scan-helper"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup()
    cleanup = null
  }
})

describe("e2e: scan on fixtures/nestjs-billing", () => {
  it("passes all 11 integrity invariants and emits the schema-pinned IR", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const result = await scanFixture(fixture.root)

    // scan() throws before returning on any integrity violation. Reaching this
    // assertion means every invariant passed for the whole billing fixture.
    expect(result.ir.$schema).toBe("https://aburi.dev/schema/aburi.ir.v1.json")
    expect(result.parseErrors).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it("recognises every fixture source file and none get skipped", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const result = await scanFixture(fixture.root)

    // 10 handwritten .ts files under src/. Skipped discovery would let the assertion
    // slide silently — the concrete integer catches a regression the moment
    // discoverFiles' ignore rules start dropping something they should not.
    expect(result.ir.stats.totalFiles).toBe(10)
    expect(result.ir.stats.parsedFiles).toBe(10)
  })

  it("classifies NestJS controllers as framework:nestjs:controller with boundary routes", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const result = await scanFixture(fixture.root)

    const controllers = result.ir.symbols.filter((s) => s.extKind === "framework:nestjs:controller")
    expect(controllers.map((c) => c.name).sort()).toEqual([
      "BillingController",
      "CustomersController",
    ])

    const routes = result.ir.symbols.filter((s) => s.extKind === "framework:nestjs:route")
    // BillingController: create / read / send. CustomersController: create / read / list.
    expect(routes.length).toBe(6)
    // Every route must carry `boundary: true` — that's the whole reason drop-b
    // exempts them from the "dropped" list. A regression here would let route
    // handlers get dropped as ordinary methods, defeating the framework plugin.
    for (const route of routes) {
      const routeDecorator = route.decorators.find((d) => d.boundary)
      expect(routeDecorator, `route ${route.id} is missing a boundary decorator`).toBeDefined()
    }
  })

  it("classifies @Injectable services as framework:nestjs:provider and keeps their methods", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const result = await scanFixture(fixture.root)

    const providers = result.ir.symbols.filter((s) => s.extKind === "framework:nestjs:provider")
    expect(providers.map((p) => p.name).sort()).toEqual([
      "BillingService",
      "CustomersService",
      "LoggerService",
    ])

    // BillingService has 12 methods (createInvoice … renumber). Every one has a
    // real body, so none should be dropped in the base state — this is what
    // scenario B mutates against.
    const billingMethods = result.ir.symbols.filter(
      (s) => s.kind === "method" && s.source.file.endsWith("billing/billing.service.ts"),
    )
    expect(billingMethods.length).toBeGreaterThanOrEqual(12)
    const droppedBillingMethods = billingMethods.filter((s) => s.dropped)
    expect(
      droppedBillingMethods,
      "no BillingService method should be dropped in the base state",
    ).toEqual([])
  })

  it("emits nestjs modules with framework:nestjs:module extKind", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const result = await scanFixture(fixture.root)

    const modules = result.ir.symbols.filter((s) => s.extKind === "framework:nestjs:module")
    expect(modules.map((m) => m.name).sort()).toEqual([
      "AppModule",
      "BillingModule",
      "CustomersModule",
    ])
  })
})
