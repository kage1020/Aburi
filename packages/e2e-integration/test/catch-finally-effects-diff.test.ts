import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A database write added in a `catch` or a `finally` block is a logic change. Neither block was
 * walked, so the write reached no `effects[]` and the diff filed the edit as syntax-only
 * (ir-schema.md §8.1, issue #333).
 */

const workspace = useScratchWorkspace("catch-finally-effects")

async function scanOf(source: string): Promise<IR> {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("src/transfer.ts", source)
  const { ir } = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    effects: [prismaEffectsPlugin],
  })
  return ir
}

function transfer(inCatch: string, inFinally: string): string {
  return [
    'import { PrismaClient } from "@prisma/client"',
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
    "function report(e: unknown) {}",
    "function release(id: string) {}",
    "",
  ].join("\n")
}

describe("scan + diff — writes in catch and finally", () => {
  it("records them as effects and reports the edit as a logic change", async () => {
    const baseIR = await scanOf(transfer("", ""))
    const headIR = await scanOf(
      transfer(
        "    await prisma.account.deleteMany({ where: { id } })",
        "    await prisma.lock.delete({ where: { id } })",
      ),
    )

    const head = headIR.symbols.find((s) => s.id === "ts:src/transfer.ts#transfer")
    expect(head?.effects.map((e) => `${e.id} ${e.target}`)).toEqual([
      "db.write prisma.account.update",
      "db.write prisma.account.deleteMany",
      "db.write prisma.lock.delete",
    ])

    const diff = diffIRs(baseIR, headIR)
    const change = diff.symbols.find(
      (s) => s.status === "changed" && s.after.id === "ts:src/transfer.ts#transfer",
    )
    expect(change?.status === "changed" && change.delta.logicChanged).toBe(true)
  })
})
