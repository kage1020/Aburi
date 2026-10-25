import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { commitAll, git, initRepository } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { readIR, runDiff, runScan } from "../../src"
import { useFixtureCheckout } from "./project"

const fixture = useFixtureCheckout("effects-coverage")

function attributed(ir: IR): string[] {
  return ir.symbols.flatMap((symbol) =>
    symbol.effects
      .filter((effect) => effect.propagated !== true)
      .map(
        (effect) =>
          `${symbol.name}: ${effect.id} \`${effect.target}\` (L${effect.line}) [${effect.plugin}] ${effect.confidence} ${effect.derivedBy}`,
      ),
  )
}

/** Each Symbol's effect rows in a Markdown diff report, the propagated ones left out. */
function effectRows(report: string): Record<string, string[]> {
  const rows: Record<string, string[]> = {}
  let symbol = ""
  let group: string | null = null
  for (const line of report.split("\n")) {
    const heading = /^### `(.+?)`/.exec(line)?.[1]
    const opened = /^- (effects (?:added|removed|modified)):$/.exec(line)?.[1]
    if (heading !== undefined) symbol = heading
    if (opened !== undefined) group = opened
    else if (!line.startsWith("  - ")) group = null
    else if (group !== null && !line.includes("[propagated from")) {
      rows[symbol] = [...(rows[symbol] ?? []), `${group}: ${line.slice("  - ".length)}`]
    }
  }
  return rows
}

async function rewrite(file: string, from: string, to: string): Promise<void> {
  const path = resolve(fixture.root, file)
  const source = await readFile(path, "utf8")
  if (!source.includes(from)) throw new Error(`${file} no longer contains ${JSON.stringify(from)}`)
  await writeFile(path, source.replace(from, to), "utf8")
}

describe("aburi scan — a project that calls into every shipped effects plugin", () => {
  it("attributes each call to the plugin that models it, with its evidence", async () => {
    const report = await runScan({
      cwd: fixture.root,
      outputDir: resolve(dirname(fixture.root), "scan"),
      format: "json",
    })

    expect(attributed(await readIR(report.irPath ?? ""))).toEqual([
      "AuditRepository.forget: db.write `this.db.delete` (L19) [effects-drizzle] high effects-plugin:drizzle:write",
      "AuditRepository.history: db.read `this.db.select` (L15) [effects-drizzle] high effects-plugin:drizzle:read",
      "AuditRepository.record: db.write `this.db.insert` (L11) [effects-drizzle] high effects-plugin:drizzle:write",
      "OrdersService.cancel: db.read `prisma.order.findUniqueOrThrow` (L37) [effects-prisma] high effects-plugin:prisma:read",
      "OrdersService.cancel: db.transaction `prisma.$transaction` (L39) [effects-prisma] high effects-plugin:prisma:tx",
      "OrdersService.cancel: db.write `prisma.order.update` (L40) [effects-prisma] high effects-plugin:prisma:write",
      "OrdersService.cancel: db.write `prisma.orderLine.deleteMany` (L41) [effects-prisma] high effects-plugin:prisma:write",
      "OrdersService.cancel: event.publish `this.eventBus.emit` (L44) [effects-nest] high effects-plugin:nest:eventBus.emit",
      "OrdersService.create: db.write `prisma.order.create` (L20) [effects-prisma] high effects-plugin:prisma:write",
      "OrdersService.create: db.write `prisma.order.update` (L22) [effects-prisma] high effects-plugin:prisma:write",
      "OrdersService.create: event.publish `this.eventBus.emit` (L24) [effects-nest] high effects-plugin:nest:eventBus.emit",
      "OrdersService.find: db.read `prisma.order.findUnique` (L29) [effects-prisma] high effects-plugin:prisma:read",
      "OrdersService.list: db.read `prisma.order.findMany` (L33) [effects-prisma] high effects-plugin:prisma:read",
      "OrdersService.purge: db.write `prisma.order.delete` (L48) [effects-prisma] high effects-plugin:prisma:write",
      "PaymentsClient.charge: network.rpc `client.payments.charge.mutate` (L12) [effects-trpc] high effects-plugin:trpc:mutation:payments.charge",
      "PaymentsClient.refund: network.rpc `client.payments.refund.mutate` (L16) [effects-trpc] high effects-plugin:trpc:mutation:payments.refund",
      "PaymentsClient.status: network.rpc `client.payments.status.query` (L20) [effects-trpc] high effects-plugin:trpc:query:payments.status",
    ])
  })
})

describe("aburi diff — one edited call per effects plugin", () => {
  it("reports each effect the edit added or removed, on the Symbol that makes the call", async () => {
    await initRepository(fixture.root)
    await commitAll(fixture.root, "base")
    await git(["checkout", "-q", "-b", "edit"], fixture.root)
    await rewrite(
      "src/orders/orders.service.ts",
      "await prisma.order.delete({ where: { id } })",
      'await prisma.order.update({ where: { id }, data: { status: "purged" } })',
    )
    await rewrite(
      "src/orders/orders.service.ts",
      '    this.eventBus.emit("order.cancelled", { orderId: id })\n',
      "",
    )
    await rewrite(
      "src/audit/audit.repository.ts",
      "await this.db.delete(auditLog)",
      'await this.db.update(auditLog).set({ action: "forgotten" })',
    )
    await rewrite(
      "src/payments/payments.client.ts",
      "client.payments.status.query",
      "client.payments.lookup.query",
    )
    await commitAll(fixture.root, "edit")

    const report = await runDiff({
      cwd: fixture.root,
      refSpec: "main..edit",
      outputDir: resolve(dirname(fixture.root), "diff"),
    })

    expect(effectRows(await readFile(report.diffMdPath ?? "", "utf8"))).toEqual({
      "AuditRepository.forget": [
        "effects added: db.write: `this.db.update` (L19) [effects-drizzle]",
        "effects removed: db.write: `this.db.delete` (L19) [effects-drizzle]",
      ],
      "OrdersService.cancel": [
        "effects removed: event.publish: `this.eventBus.emit` (L44) [effects-nest]",
      ],
      "OrdersService.purge": [
        "effects added: db.write: `prisma.order.update` (L47) [effects-prisma]",
        "effects removed: db.write: `prisma.order.delete` (L48) [effects-prisma]",
      ],
      "PaymentsClient.status": [
        "effects added: network.rpc: `client.payments.lookup.query` (L20) [effects-trpc]",
        "effects removed: network.rpc: `client.payments.status.query` (L20) [effects-trpc]",
      ],
    })
  })
})
