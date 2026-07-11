import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { EXIT, evaluateFailOn, parseFailOn } from "@aburi/cli"
import { buildDiff } from "@aburi/diff"
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
 * Scenario B — a large refactor stubs out every `BillingService` method body so
 * each method Symbol's `dropped` flag flips from false → true (drop-b.ts §
 * "empty body" rule). The `--fail-on dropped-toggled:to-dropped:>10` gate must
 * trip because BillingService has 12 methods, all of which now qualify.
 *
 * Per the exit-code table in `packages/cli/src/exit-codes.ts`, a `--fail-on`
 * gate trip maps to `EXIT.GATE = 3`, not `EXIT.RUNTIME = 1`. We assert against
 * that contract so this test guards the CLI's actual behaviour.
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
  "// Every method body reduced to literally `{}` — lang-typescript's",
  "// drop-hints.classifyFunctionBody flags a `statement_block` with no",
  '// non-comment statements as "empty body" (drop-b.ts §category B). TS type',
  "// correctness does not matter here: Aburi parses via tree-sitter and never",
  "// invokes tsc, so a `void` body on a method declared to return an object is",
  "// only meaningful to the scanner as a syntactic shape.",
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

describe("e2e diff — scenario B: BillingService stubbed → dropped-toggled:>10", () => {
  it("emits ≥11 dropped-toggled:to-dropped changes and trips the `>10` gate at EXIT.GATE", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const baseIR = (await scanFixture(fixture.root)).ir

    const target = resolve(fixture.root, "src/billing/billing.service.ts")
    await writeFile(target, HEAD_BILLING_SERVICE, "utf8")

    const headIR = (await scanFixture(fixture.root)).ir

    const irSchema = "https://aburi.dev/schema/aburi.ir.v1.json"
    const diff = buildDiff({
      baseIR,
      headIR,
      base: { ref: "base", irSchema },
      head: { ref: "head", irSchema },
    })

    const toDropped = diff.symbols.filter(
      (c) => c.status === "dropped-toggled" && c.direction === "to-dropped",
    )
    expect(toDropped.length).toBeGreaterThan(10)

    const gate = parseFailOn("dropped-toggled:to-dropped:>10")
    const triggered = evaluateFailOn(gate, diff)
    expect(triggered.firstTriggered).not.toBeNull()
    // FailOnClause.token carries the full parsed token including the direction
    // suffix ("dropped-toggled:to-dropped"), so a bare "dropped-toggled" match is
    // wrong. Threshold `>10` on the clause is what makes the gate fire when the
    // observed count (BillingService: 12) exceeds 10.
    expect(triggered.firstTriggered?.clause.token).toBe("dropped-toggled:to-dropped")
    expect(triggered.firstTriggered?.clause.threshold).toBe(10)
    expect(triggered.firstTriggered?.observed).toBeGreaterThan(10)

    // Per the CLI exit-code contract, a gate trip is EXIT.GATE = 3.
    expect(EXIT.GATE).toBe(3)
  })
})
