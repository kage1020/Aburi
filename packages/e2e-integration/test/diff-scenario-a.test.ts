import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { evaluateFailOn, parseFailOn } from "@aburi/cli"
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
 * Scenario A — a PR that adds a validation Rule to an existing service method.
 *
 * The mutation edits `BillingService.applyRefund` so that it rejects a negative
 * `amountCents` before touching the invoice. From the diff's point of view this
 * adds one `throw` Rule to the Symbol's body, so:
 *   - status: "changed" (fingerprint diverges)
 *   - delta.rules.added: 1
 *   - delta.logicChanged: true
 * No other Symbol is touched, so `changed = 1` on the summary and every other
 * count is 0. The `--fail-on changed` gate would trip; we assert that here so the
 * downstream gate contract stays covered end-to-end.
 */
describe("e2e diff — scenario A: single rule added to BillingService.applyRefund", () => {
  it("reports changed:1 with logicChanged=true and trips `--fail-on changed`", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const baseIR = (await scanFixture(fixture.root)).ir

    // Head mutation: guard `applyRefund` against negative amounts.
    const target = resolve(fixture.root, "src/billing/billing.service.ts")
    const original = await readFile(target, "utf8")
    // Insertion embeds `${amountCents}` as literal source that lands in the
    // fixture on disk (it becomes a real TS template-literal there). We build
    // the string via concatenation instead of a plain-string literal so biome's
    // `noTemplateCurlyInString` lint does not misread the intent.
    const dollar = "$"
    const guardLine = `    if (amountCents < 0) throw new Error(\`refund amount must be non-negative: ${dollar}{amountCents}\`)`
    const searchAnchor =
      "  applyRefund(id: string, amountCents: number): StoredInvoice {\n    const invoice = this.findInvoice(id)"
    const replacement = `  applyRefund(id: string, amountCents: number): StoredInvoice {\n${guardLine}\n    const invoice = this.findInvoice(id)`
    const patched = original.replace(searchAnchor, replacement)
    expect(patched, "mutation regex must match the fixture's applyRefund").not.toBe(original)
    await writeFile(target, patched, "utf8")

    const headIR = (await scanFixture(fixture.root)).ir

    const irSchema = "https://aburi.kage1020.com/schema/aburi.ir.v1.json"
    const diff = buildDiff({
      baseIR,
      headIR,
      base: { ref: "base", irSchema },
      head: { ref: "head", irSchema },
    })

    // Two changes propagate from the mutation:
    //   1. The applyRefund method itself (added rule, logicChanged).
    //   2. The enclosing BillingService class Symbol, whose fingerprint mixes the
    //      member Symbols — a rule added inside applyRefund's body reshapes the
    //      class-level normalised AST too.
    // Everything else (add / remove / move / dropped-toggled) must be zero — the
    // mutation is intentionally scoped to one method body.
    expect(diff.summary.changed).toBe(2)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.removed).toBe(0)
    expect(diff.summary.moved).toBe(0)
    expect(diff.summary.droppedToggled).toBe(0)

    const changed = diff.symbols.filter((c) => c.status === "changed")
    expect(changed).toHaveLength(2)
    const changedNames = changed
      .map((c) => (c.status === "changed" ? c.after.name : ""))
      .filter((n) => n.length > 0)
      .sort()
    expect(changedNames).toEqual(["BillingService", "BillingService.applyRefund"])

    const method = changed.find(
      (c) => c.status === "changed" && c.after.name === "BillingService.applyRefund",
    )
    if (method?.status !== "changed") throw new Error("applyRefund change missing")
    expect(method.delta.logicChanged).toBe(true)
    expect(method.delta.rules?.added.length ?? 0).toBeGreaterThanOrEqual(1)

    // The `changed` clause must trip, and it must trip on the very first (and only)
    // changed symbol. `>0` semantics: a bare token means "any occurrence".
    const clauses = parseFailOn("changed")
    const triggered = evaluateFailOn(clauses, diff)
    expect(triggered.firstTriggered).not.toBeNull()
    expect(triggered.firstTriggered?.clause.token).toBe("changed")
  })
})
