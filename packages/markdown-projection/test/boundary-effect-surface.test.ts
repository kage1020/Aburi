import { component, decorator, effect, makeSymbol } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectComponent } from "../src"
import { sectionOf } from "./markdown"

function page(symbols: IRSymbol[]): string {
  return projectComponent({
    component: component({ id: "billing", name: "Billing" }),
    symbols,
    dependencies: [],
  })
}

const write = effect({ id: "db.write", target: "prisma.invoice.create", plugin: "effects-prisma" })

describe("projectComponent — Boundary effect surface", () => {
  it.each<[string, IRSymbol]>([
    [
      "a Symbol that is no boundary",
      makeSymbol({ id: "ts:src/util.ts#internal", name: "internal", effects: [write] }),
    ],
    [
      "a boundary with no effect",
      makeSymbol({
        id: "ts:src/ctl.ts#Ctl.list",
        name: "Ctl.list",
        decorators: [decorator({ name: "Get", boundary: true })],
      }),
    ],
  ])("omits the section given only %s", (_, symbol) => {
    expect(page([symbol])).not.toContain("Boundary effect surface")
  })

  it("lists each boundary's local and propagated effects, Symbols by id and effects by id then target", () => {
    const md = page([
      makeSymbol({
        id: "ts:src/ctl.ts#Ctl.update",
        name: "Ctl.update",
        decorators: [decorator({ name: "Put", boundary: true })],
        effects: [write],
      }),
      makeSymbol({
        id: "ts:src/ctl.ts#Ctl.create",
        name: "Ctl.create",
        decorators: [decorator({ name: "Post", boundary: true })],
        effects: [
          effect({ id: "queue.publish", target: "bus.emit", plugin: "effects-nest", line: 7 }),
          effect({
            id: "db.write",
            target: "prisma.invoice.create",
            plugin: "effects-prisma",
            confidence: "medium",
            propagated: true,
            derivedFrom: ["ts:src/svc.ts#Svc.persist", "ts:src/other.ts#Other.helper"],
          }),
          effect({ id: "db.write", target: "prisma.audit.create", plugin: "effects-prisma" }),
        ],
      }),
    ])
    expect(sectionOf(md, "## Boundary effect surface")).toEqual([
      "## Boundary effect surface",
      "",
      "- `Ctl.create` — db.write(`prisma.audit.create`), db.write(`prisma.invoice.create`) " +
        "[propagated from ts:src/svc.ts#Svc.persist, ts:src/other.ts#Other.helper], " +
        "queue.publish(`bus.emit`)",
      "- `Ctl.update` — db.write(`prisma.invoice.create`)",
      "",
    ])
  })

  it("treats a framework:* extKind as a boundary even when no decorator flags it", () => {
    const md = page([
      makeSymbol({
        id: "ts:src/app/api/orders/route.ts#POST",
        name: "POST",
        extKind: "framework:next:route",
        effects: [
          effect({ id: "db.write", target: "prisma.order.create", plugin: "effects-prisma" }),
        ],
      }),
    ])
    expect(md).toContain(
      "## Boundary effect surface\n\n- `POST` — db.write(`prisma.order.create`)\n",
    )
  })
})
