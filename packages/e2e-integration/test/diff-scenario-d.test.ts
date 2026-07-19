import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
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

/**
 * Scenario D — a controller inherits a `db.write` transitively.
 *
 * The scenario chains three top-level functions across three files so the untyped
 * call-graph resolver (call-resolution.md §4.3–§4.6) can link them without needing
 * LSP-tier `this.<method>` support (§4.7 deliberately leaves that unresolved).
 *
 *   controller.persistedRoute → service.persistInvoiceService → repo.writeInvoice
 *                                                                    ↓
 *                                                        prisma.invoice.create (db.write)
 *
 * With the effect-propagation pass in place, the boundary controller method
 * carries a `propagated: true` `db.write` entry whose `derivedFrom` names the
 * *direct* upstream callee (the service function), not the repository. This is
 * the primary end-to-end guarantee of effect-propagation.md §4.1 / §5.2.
 */
const INVOICE_REPOSITORY_TS = `import type { PrismaClient } from "@prisma/client"

export async function writeInvoice(
  prisma: PrismaClient,
  data: { customerId: string; amountCents: number },
): Promise<{ id: string }> {
  return prisma.invoice.create({ data })
}
`

const BILLING_SERVICE_APPEND = `

import type { PrismaClient } from "@prisma/client"
import { writeInvoice } from "./invoice.repository"

export async function persistInvoiceService(
  prisma: PrismaClient,
  dto: { customerId: string; amountCents: number },
): Promise<{ id: string }> {
  return writeInvoice(prisma, dto)
}
`

const BILLING_CONTROLLER_APPEND = `

import type { PrismaClient } from "@prisma/client"
import { persistInvoiceService } from "./billing.service"

@Controller("persisted")
export class PersistedInvoiceController {
  @Post()
  createPersisted(
    prisma: PrismaClient,
    @Body() dto: { customerId: string; amountCents: number },
  ) {
    return persistInvoiceService(prisma, dto)
  }
}
`

describe("e2e scenario D — controller inherits db.write via propagation", () => {
  it("propagates db.write from repository → service → boundary controller", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const billingDir = resolve(fixture.root, "src/billing")
    await mkdir(billingDir, { recursive: true })
    await writeFile(resolve(billingDir, "invoice.repository.ts"), INVOICE_REPOSITORY_TS, "utf8")

    const servicePath = resolve(billingDir, "billing.service.ts")
    const service = await readFile(servicePath, "utf8")
    await writeFile(servicePath, service + BILLING_SERVICE_APPEND, "utf8")

    const controllerPath = resolve(billingDir, "billing.controller.ts")
    const controller = await readFile(controllerPath, "utf8")
    await writeFile(controllerPath, controller + BILLING_CONTROLLER_APPEND, "utf8")

    const { ir } = await scanFixture(fixture.root, {}, { effects: [prismaEffectsPlugin] })

    const findSymbol = (suffix: string) => {
      const found = ir.symbols.find((s) => s.id.endsWith(suffix))
      if (found === undefined) {
        throw new Error(
          `no Symbol id ends with ${suffix}; ids seen: ${ir.symbols.map((s) => s.id).join(", ")}`,
        )
      }
      return found
    }

    const repoWrite = findSymbol("invoice.repository.ts#writeInvoice")
    const svcPersist = findSymbol("billing.service.ts#persistInvoiceService")
    const ctlPersist = findSymbol("#PersistedInvoiceController.createPersisted")

    // Repository has the LOCAL prisma.invoice.create effect.
    const repoLocal = repoWrite.effects.find(
      (e) => e.id === "db.write" && e.target.endsWith(".invoice.create"),
    )
    expect(repoLocal, "expected writeInvoice to hold local db.write").toBeDefined()
    expect(repoLocal?.propagated).not.toBe(true)
    expect(repoLocal?.line).toBeDefined()

    // Service function carries a PROPAGATED db.write; derivedFrom = [repo.writeInvoice].
    const svcPropagated = svcPersist.effects.find(
      (e) => e.id === "db.write" && e.propagated === true,
    )
    expect(
      svcPropagated,
      "expected persistInvoiceService to carry propagated db.write",
    ).toBeDefined()
    expect(svcPropagated?.line).toBeUndefined()
    expect(svcPropagated?.derivedFrom).toEqual([repoWrite.id])

    // Controller (boundary) carries a PROPAGATED db.write; derivedFrom = [service function].
    const ctlPropagated = ctlPersist.effects.find(
      (e) => e.id === "db.write" && e.propagated === true,
    )
    expect(ctlPropagated, "expected boundary controller to carry propagated db.write").toBeDefined()
    expect(ctlPropagated?.line).toBeUndefined()
    expect(ctlPropagated?.derivedFrom).toEqual([svcPersist.id])

    // Boundary decorator flag proves the framework plugin still classified the new
    // handler as boundary (effect-propagation.md §4.3 — boundary is not a stop).
    expect(ctlPersist.decorators.some((d) => d.boundary === true)).toBe(true)

    // Stats surface the propagation shape end-to-end.
    expect(ir.stats.effectPropagation).toBeDefined()
    expect(ir.stats.effectPropagation?.propagatedEffectCount ?? 0).toBeGreaterThanOrEqual(2)
    expect(ir.stats.effectPropagation?.symbolsWithPropagatedEffects ?? 0).toBeGreaterThanOrEqual(2)
  })
})
