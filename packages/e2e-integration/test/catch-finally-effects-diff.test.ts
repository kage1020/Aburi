import type { ScanResult } from "@aburi/core"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith, symbolById } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A database write added in a `catch` or a `finally` block is a logic change, because adding an
 * effect moves `logic` (fingerprint.md §4.4). Neither block was walked, so the write reached no
 * `effects[]`, and the diff filed the edit under syntax-only changes (markdown-projection.md
 * §6.2). A call to a helper that writes reaches `logic` the long way round: the call resolves to
 * the helper, and the helper's effect propagates to the caller.
 */

const workspace = useScratchWorkspace("catch-finally-effects")

const TRANSFER = "ts:src/transfer.ts#transfer"
const AUDIT = "ts:src/audit.ts#audit"

/** A helper with a body of its own, so it is kept, and a call to it resolves and propagates. */
const AUDIT_TS = [
  'import { PrismaClient } from "@prisma/client"',
  "const prisma = new PrismaClient()",
  "",
  "export async function audit(id: string) {",
  "  await prisma.audit.create({ data: { id } })",
  "}",
  "",
].join("\n")

async function scanOf(transferSource: string): Promise<ScanResult> {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("src/audit.ts", AUDIT_TS)
  await workspace.writeSource("src/transfer.ts", transferSource)
  return scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    effects: [prismaEffectsPlugin],
  })
}

/** `report` and `release` are declared nowhere: they stand for calls no plugin classifies. */
function transfer(inCatch: string, inFinally: string): string {
  return [
    'import { PrismaClient } from "@prisma/client"',
    'import { audit } from "./audit"',
    "const prisma = new PrismaClient()",
    "",
    "export async function transfer(id: string, amount: number) {",
    "  try {",
    "    await prisma.account.update({ where: { id }, data: { balance: { decrement: amount } } })",
    "  } catch (e) {",
    inCatch,
    "    report(e)",
    "    throw e",
    "  } finally {",
    inFinally,
    "    release(id)",
    "  }",
    "}",
    "",
  ].join("\n")
}

describe("scan + diff — writes in catch and finally", () => {
  it("records them as effects and reports the edit as a logic change", async () => {
    const base = await scanOf(transfer("", ""))
    const head = await scanOf(
      transfer(
        "    await prisma.account.deleteMany({ where: { id } })",
        "    await prisma.lock.delete({ where: { id } })",
      ),
    )

    const symbol = symbolById(head, TRANSFER)
    expect(symbol.effects.map((e) => `${e.id} ${e.target}`)).toEqual([
      "db.write prisma.account.update",
      "db.write prisma.account.deleteMany",
      "db.write prisma.lock.delete",
    ])
    // The catch clause's `throw e` is withheld (ir-schema.md §8.2): the one rule is the `try`.
    expect(symbol.rules.map((r) => r.type)).toEqual(["try"])
    expect(head.ir.stats.effectClassifyTimeouts).toBeUndefined()
    expect(head.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)

    const changes = diffIRs(base.ir, head.ir).symbols
    expect(changes).toHaveLength(1)
    const [change] = changes
    expect(change?.status).toBe("changed")
    if (change?.status !== "changed") return
    expect(change.after.id).toBe(TRANSFER)
    expect(change.delta.logicChanged).toBe(true)
  })

  it("reports a rewritten catch clause that adds no effect as syntax-only", async () => {
    // The guard is the catch clause's control flow, which ir-schema.md §8.2 keeps out of the
    // Symbol's rules. Were it let in, every edit to an error handler would trip
    // `--fail-on logic-changed`.
    const base = await scanOf(transfer("", ""))
    const head = await scanOf(transfer("    if (e instanceof TypeError) return", ""))

    expect(symbolById(head, TRANSFER).rules.map((r) => r.type)).toEqual(["try"])

    const changes = diffIRs(base.ir, head.ir).symbols
    expect(changes).toHaveLength(1)
    const [change] = changes
    expect(change?.status).toBe("changed")
    if (change?.status !== "changed") return
    expect(change.after.id).toBe(TRANSFER)
    expect(change.delta.logicChanged).toBe(false)
    expect(change.delta.syntaxChanged).toBe(true)
  })
})

describe("scan + diff — a call in catch or finally to a helper that writes", () => {
  // The two clauses go through different code in the walk (`handleTryStatement`), so each gets
  // its own case.
  it.each([
    ["catch", "    await audit(id)", ""],
    ["finally", "", "    await audit(id)"],
  ])("resolves the call in %s and inherits the helper's write", async (_label, inCatch, inFinally) => {
    const base = await scanOf(transfer("", ""))
    const head = await scanOf(transfer(inCatch, inFinally))

    const symbol = symbolById(head, TRANSFER)
    expect(symbol.calls.filter((c) => c.target === "audit")).toEqual([
      expect.objectContaining({ resolved: AUDIT }),
    ])
    expect(head.ir.dependencies).toContainEqual(
      expect.objectContaining({ from: TRANSFER, to: AUDIT, via: "call" }),
    )
    const propagated = symbol.effects.filter((e) => e.propagated === true)
    expect(propagated.map((e) => [e.id, e.target, e.derivedFrom])).toEqual([
      ["db.write", "prisma.audit.create", [AUDIT]],
    ])
    expect(head.ir.stats.effectPropagation.propagatedEffectCount).toBeGreaterThanOrEqual(1)
    expect(head.ir.stats.effectClassifyTimeouts).toBeUndefined()

    const changes = diffIRs(base.ir, head.ir).symbols
    expect(changes).toHaveLength(1)
    const [change] = changes
    expect(change?.status).toBe("changed")
    if (change?.status !== "changed") return
    expect(change.after.id).toBe(TRANSFER)
    expect(change.delta.logicChanged).toBe(true)
  })
})
