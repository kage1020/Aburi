import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { evaluateFailOn, parseFailOn } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { diffIRs, scanFixture } from "../src/scan-helper"

/**
 * Scenario B — a large refactor stubs out every `BillingService` method body so each method
 * Symbol's `dropped` flag flips from false → true (drop-b.ts "empty body" rule). The
 * `--fail-on dropped-toggled:to-dropped:>10` gate must trip: BillingService has 12 methods,
 * all of which now qualify.
 */
const HEAD_BILLING_SERVICE = [
  'import { Injectable } from "@nestjs/common"',
  'import { LoggerService } from "../common/logger.service"',
  'import { CreateInvoiceDto } from "./dto/create-invoice.dto"',
  "",
  "interface StoredInvoice {",
  "  id: string",
  "  customerId: string",
  "  amountCents: number",
  "  currency: string",
  "  dueAt: string",
  "  memo?: string",
  '  status: "draft" | "sent" | "paid" | "void"',
  "}",
  "",
  "// Every method body reduced to literally `{}`. TS type correctness does not matter:",
  "// Aburi parses via tree-sitter and never invokes tsc, so a `void` body on a method",
  "// declared to return an object is only meaningful to the scanner as a syntactic shape.",
  "@Injectable()",
  "export class BillingService {",
  "  private readonly invoices: StoredInvoice[] = []",
  "  constructor(private readonly _logger: LoggerService) {}",
  "  createInvoice(_dto: CreateInvoiceDto) {}",
  "  findInvoice(_id: string) {}",
  "  listInvoices(_customerId?: string) {}",
  "  markSent(_id: string) {}",
  "  markPaid(_id: string) {}",
  "  voidInvoice(_id: string) {}",
  "  totalDue(_customerId: string) {}",
  "  computeLateFee(_id: string, _todayIso: string) {}",
  "  applyRefund(_id: string, _amountCents: number) {}",
  "  archiveOldInvoices(_cutoffIso: string) {}",
  '  countByStatus(_status: StoredInvoice["status"]) {}',
  "  renumber() {}",
  "}",
  "",
].join("\n")

const fixture = useFixtureCheckout()

describe("e2e diff — scenario B: BillingService stubbed → dropped-toggled:>10", () => {
  it("emits ≥11 dropped-toggled:to-dropped changes and trips the `>10` gate", async () => {
    const baseIR = (await scanFixture(fixture.root)).ir

    await writeFile(
      resolve(fixture.root, "src/billing/billing.service.ts"),
      HEAD_BILLING_SERVICE,
      "utf8",
    )

    const headIR = (await scanFixture(fixture.root)).ir
    const diff = diffIRs(baseIR, headIR)

    const toDropped = diff.symbols.filter(
      (c) => c.status === "dropped-toggled" && c.direction === "to-dropped",
    )
    expect(toDropped.length).toBeGreaterThan(10)

    const triggered = evaluateFailOn(parseFailOn("dropped-toggled:to-dropped:>10"), diff)
    expect(triggered.firstTriggered).not.toBeNull()
    // `FailOnClause.token` carries the direction suffix, so a bare "dropped-toggled" match
    // would be wrong.
    expect(triggered.firstTriggered?.clause.token).toBe("dropped-toggled:to-dropped")
    expect(triggered.firstTriggered?.clause.threshold).toBe(10)
    expect(triggered.firstTriggered?.observed).toBeGreaterThan(10)
  })
})
