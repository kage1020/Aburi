import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { evaluateFailOn, parseFailOn } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { diffIRs, scanFixture } from "../src/scan-helper"

/**
 * Scenario A — a PR that adds a validation Rule to an existing service method.
 *
 * The mutation edits `BillingService.applyRefund` so that it rejects a negative
 * `amountCents` before touching the invoice: one `throw` Rule added to the Symbol's body, so
 * `status: "changed"`, `delta.rules.added: 1`, `delta.logicChanged: true`, and the
 * `--fail-on changed` gate trips.
 */

const fixture = useFixtureCheckout()

describe("e2e diff — scenario A: single rule added to BillingService.applyRefund", () => {
  it("reports changed:1 with logicChanged=true and trips `--fail-on changed`", async () => {
    const baseIR = (await scanFixture(fixture.root)).ir

    const target = resolve(fixture.root, "src/billing/billing.service.ts")
    const original = await readFile(target, "utf8")
    // The inserted line embeds `${amountCents}` as literal source; built by concatenation so
    // biome's `noTemplateCurlyInString` does not misread the intent.
    const dollar = "$"
    const guardLine = `    if (amountCents < 0) throw new Error(\`refund amount must be non-negative: ${dollar}{amountCents}\`)`
    const searchAnchor =
      "  applyRefund(id: string, amountCents: number): StoredInvoice {\n    const invoice = this.findInvoice(id)"
    const replacement = `  applyRefund(id: string, amountCents: number): StoredInvoice {\n${guardLine}\n    const invoice = this.findInvoice(id)`
    const patched = original.replace(searchAnchor, replacement)
    expect(patched, "mutation regex must match the fixture's applyRefund").not.toBe(original)
    await writeFile(target, patched, "utf8")

    const headIR = (await scanFixture(fixture.root)).ir
    const diff = diffIRs(baseIR, headIR)

    // Two changes propagate from the mutation: the applyRefund method itself, and the
    // enclosing BillingService class Symbol, whose fingerprint mixes the member Symbols.
    // Everything else must be zero — the mutation is scoped to one method body.
    expect(diff.summary.changed).toBe(2)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.removed).toBe(0)
    expect(diff.summary.moved).toBe(0)
    expect(diff.summary.droppedToggled).toBe(0)

    const changed = diff.symbols.filter((c) => c.status === "changed")
    expect(changed).toHaveLength(2)
    const changedNames = changed
      .map((c) => (c.status === "changed" ? c.after.name : ""))
      .filter((name) => name.length > 0)
      .sort()
    expect(changedNames).toEqual(["BillingService", "BillingService.applyRefund"])

    const method = changed.find(
      (c) => c.status === "changed" && c.after.name === "BillingService.applyRefund",
    )
    if (method?.status !== "changed") throw new Error("applyRefund change missing")
    expect(method.delta.logicChanged).toBe(true)
    expect(method.delta.rules?.added.length ?? 0).toBeGreaterThanOrEqual(1)

    // A bare token means "any occurrence", so `changed` trips on the first changed symbol.
    const triggered = evaluateFailOn(parseFailOn("changed"), diff)
    expect(triggered.firstTriggered).not.toBeNull()
    expect(triggered.firstTriggered?.clause.token).toBe("changed")
  })
})
