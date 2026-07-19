import { describe, expect, it } from "vitest"
import { projectComponent } from "../src"
import { component, decorator, effect, makeSymbol } from "./fixtures"

/**
 * The `## Boundary effect surface` section renders on the per-component page for
 * Symbols identified as boundaries (any decorator with `boundary: true`, or an
 * `extKind` starting with `framework:`). effect-propagation.md §4.3 places this
 * rollup in the projection layer — the IR carries the augmented `effects[]` on
 * every Symbol; the view surfaces boundaries as a fast-scan entry point.
 */
describe("projectComponent — Boundary effect surface", () => {
  it("omits the section when no boundary Symbols carry effects", () => {
    const md = projectComponent({
      component: component({ id: "billing", name: "Billing" }),
      symbols: [
        makeSymbol({
          id: "ts:src/util.ts#internal",
          name: "internal",
          effects: [
            effect({ id: "db.write", target: "prisma.x.create", plugin: "effects-prisma" }),
          ],
        }),
      ],
      dependencies: [],
    })
    expect(md).not.toContain("Boundary effect surface")
  })

  it("lists local and propagated effects on boundary Symbols with derivedFrom marker", () => {
    const md = projectComponent({
      component: component({ id: "billing", name: "Billing" }),
      symbols: [
        makeSymbol({
          id: "ts:src/billing.controller.ts#BillingController.createPersisted",
          name: "BillingController.createPersisted",
          decorators: [decorator({ name: "Post", boundary: true })],
          effects: [
            {
              id: "db.write",
              target: "prisma.invoice.create",
              plugin: "effects-prisma",
              confidence: "medium",
              derivedBy: "effects-plugin:prisma:write",
              propagated: true,
              derivedFrom: ["ts:src/billing.service.ts#BillingService.persistInvoice"],
            },
          ],
        }),
      ],
      dependencies: [],
    })
    expect(md).toContain("## Boundary effect surface")
    expect(md).toContain("`BillingController.createPersisted`")
    expect(md).toContain("db.write(`prisma.invoice.create`)")
    expect(md).toContain(
      "[propagated from ts:src/billing.service.ts#BillingService.persistInvoice]",
    )
  })

  it("renders per-Symbol Effects with local first (line-monotonic) then propagated [propagated from ...]", () => {
    const md = projectComponent({
      component: component({ id: "billing", name: "Billing" }),
      symbols: [
        makeSymbol({
          id: "ts:src/billing.controller.ts#Ctl.mixed",
          name: "Ctl.mixed",
          decorators: [decorator({ name: "Post", boundary: true })],
          effects: [
            // Local at line 7 must render before the propagated segment, and the
            // local segment stays in line order regardless of (id, target) sort.
            effect({ id: "queue.publish", target: "bus.emit", plugin: "effects-nest", line: 7 }),
            // Propagated entry — line MUST NOT appear; `[propagated from …]`
            // marker MUST appear naming the sorted direct callee list.
            {
              id: "db.write",
              target: "prisma.invoice.create",
              plugin: "effects-prisma",
              confidence: "medium",
              derivedBy: "effects-plugin:prisma:write",
              propagated: true,
              derivedFrom: ["ts:src/svc.ts#Svc.persist", "ts:src/other.ts#Other.helper"],
            },
          ],
        }),
      ],
      dependencies: [],
    })
    const localIdx = md.indexOf("queue.publish: `bus.emit` (L7)")
    const propIdx = md.indexOf("db.write: `prisma.invoice.create`")
    expect(localIdx).toBeGreaterThan(-1)
    expect(propIdx).toBeGreaterThan(-1)
    expect(localIdx).toBeLessThan(propIdx)
    expect(md).toContain(
      "[propagated from ts:src/svc.ts#Svc.persist, ts:src/other.ts#Other.helper]",
    )
    // The propagated row must NOT include a line marker (`(L…)`) because that
    // would violate schema §9.4 / effect-propagation.md §5.1.
    const propRow = md.slice(propIdx, propIdx + 200)
    expect(propRow).not.toMatch(/db\.write: `prisma\.invoice\.create` \(L\d+\)/)
  })

  it("treats a framework:* extKind as a boundary even when no decorator flags it", () => {
    const md = projectComponent({
      component: component({ id: "web", name: "Web" }),
      symbols: [
        makeSymbol({
          id: "ts:src/app/api/orders/route.ts#POST",
          name: "POST",
          extKind: "framework:next:route",
          effects: [
            effect({ id: "db.write", target: "prisma.order.create", plugin: "effects-prisma" }),
          ],
        }),
      ],
      dependencies: [],
    })
    expect(md).toContain("## Boundary effect surface")
    expect(md).toContain("db.write(`prisma.order.create`)")
  })
})
