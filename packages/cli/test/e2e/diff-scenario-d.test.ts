import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { symbolById } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanFixture, useFixtureCheckout } from "./project"

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

const fixture = useFixtureCheckout()

async function appendTo(path: string, tail: string): Promise<void> {
  const current = await readFile(path, "utf8")
  await writeFile(path, current + tail, "utf8")
}

describe("e2e scan — a controller inherits db.write through propagation", () => {
  it("propagates db.write from repository → service → boundary controller", async () => {
    const billingDir = resolve(fixture.root, "src/billing")
    await writeFile(resolve(billingDir, "invoice.repository.ts"), INVOICE_REPOSITORY_TS, "utf8")
    await appendTo(resolve(billingDir, "billing.service.ts"), BILLING_SERVICE_APPEND)
    await appendTo(resolve(billingDir, "billing.controller.ts"), BILLING_CONTROLLER_APPEND)

    const result = await scanFixture(fixture.root, {}, { effects: [prismaEffectsPlugin] })
    const { ir } = result

    const repoWrite = symbolById(result, "ts:src/billing/invoice.repository.ts#writeInvoice")
    const servicePersist = symbolById(
      result,
      "ts:src/billing/billing.service.ts#persistInvoiceService",
    )
    const controllerCreate = symbolById(
      result,
      "ts:src/billing/billing.controller.ts#PersistedInvoiceController.createPersisted",
    )

    const repoLocal = repoWrite.effects.find(
      (e) => e.id === "db.write" && e.target.endsWith(".invoice.create"),
    )
    expect(repoLocal, "expected writeInvoice to hold local db.write").toBeDefined()
    expect(repoLocal?.propagated).not.toBe(true)
    expect(repoLocal?.line).toBeDefined()

    const servicePropagated = servicePersist.effects.find(
      (e) => e.id === "db.write" && e.propagated === true,
    )
    expect(
      servicePropagated,
      "expected persistInvoiceService to carry propagated db.write",
    ).toBeDefined()
    expect(servicePropagated?.line).toBeUndefined()
    expect(servicePropagated?.derivedFrom).toEqual([repoWrite.id])

    const controllerPropagated = controllerCreate.effects.find(
      (e) => e.id === "db.write" && e.propagated === true,
    )
    expect(
      controllerPropagated,
      "expected boundary controller to carry propagated db.write",
    ).toBeDefined()
    expect(controllerPropagated?.line).toBeUndefined()
    expect(controllerPropagated?.derivedFrom).toEqual([servicePersist.id])

    expect(controllerCreate.decorators.some((d) => d.boundary === true)).toBe(true)

    expect(ir.stats.effectPropagation).toBeDefined()
    expect(ir.stats.effectPropagation?.propagatedEffectCount ?? 0).toBeGreaterThanOrEqual(2)
    expect(ir.stats.effectPropagation?.symbolsWithPropagatedEffects ?? 0).toBeGreaterThanOrEqual(2)
  })
})
