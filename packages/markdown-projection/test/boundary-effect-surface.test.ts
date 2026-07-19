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
