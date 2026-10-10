import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith, type EditDiff } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

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

async function diffOfTransferEdit(edited: string): Promise<EditDiff> {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("src/audit.ts", AUDIT_TS)
  return diffOfEditWith(
    workspace,
    { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] },
    "src/transfer.ts",
    transfer("", ""),
    edited,
  )
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
    const { head, diff } = await diffOfTransferEdit(
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
    expect(symbol.rules.map((r) => r.type)).toEqual(["try"])
    expect(head.ir.stats.effectClassifyTimeouts).toBeUndefined()
    expect(head.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)

    expect(diff.symbols).toMatchObject([
      { status: "changed", after: { id: TRANSFER }, delta: { logicChanged: true } },
    ])
  })

  it("reports a rewritten catch clause that adds no effect as syntax-only", async () => {
    const { head, diff } = await diffOfTransferEdit(
      transfer("    if (e instanceof TypeError) return", ""),
    )

    expect(symbolById(head, TRANSFER).rules.map((r) => r.type)).toEqual(["try"])

    expect(diff.symbols).toMatchObject([
      {
        status: "changed",
        after: { id: TRANSFER },
        delta: { logicChanged: false, syntaxChanged: true },
      },
    ])
  })
})

describe("scan + diff — a call in catch or finally to a helper that writes", () => {
  it.each([
    ["catch", "    await audit(id)", ""],
    ["finally", "", "    await audit(id)"],
  ])("resolves the call in %s and inherits the helper's write", async (_label, inCatch, inFinally) => {
    const { head, diff } = await diffOfTransferEdit(transfer(inCatch, inFinally))

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

    expect(diff.symbols).toMatchObject([
      { status: "changed", after: { id: TRANSFER }, delta: { logicChanged: true } },
    ])
  })
})
