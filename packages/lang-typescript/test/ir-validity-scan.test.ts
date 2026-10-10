import { assertIRIntegrity, serializeCanonical } from "@aburi/core"
import { irSchemaViolations, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanTypeScript } from "./fixtures/scan"

const workspace = useScratchWorkspace("ir-validity")

describe("scan — a rule longer than the schema allows", () => {
  it("writes the IR the frozen schema accepts, counting characters as code points", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `order.f${i} > ${i}`).join(" && ")
    const parcel = "📦".repeat(60)
    await workspace.writeSource(
      "src/price.ts",
      [
        "export function price(order: any): number {",
        `  if (${long}) throw new Error("over the limit")`,
        `  if (order.label === "${parcel}" || order.label === "${parcel}") return 0`,
        `  return ${long.replaceAll(" && ", " + ")}`,
        "}",
        "",
      ].join("\n"),
    )
    const { ir } = await scanTypeScript(workspace.root)

    expect(ir.symbols.flatMap((s) => s.rules).map((r) => r.type)).toEqual([
      "guard",
      "throw",
      "guard",
      "return",
    ])
    expect(irSchemaViolations(JSON.parse(serializeCanonical(ir)))).toEqual([])
  })
})

describe("scan — a workspace whose entities are declared more than once", () => {
  it("produces a document that passes every integrity invariant", async () => {
    await workspace.writeSource(
      "src/box.ts",
      [
        "export class Box {",
        "  #v = 0",
        "  get value() {",
        "    return this.#v",
        "  }",
        "  set value(n: number) {",
        "    audit(n)",
        "    this.#v = n",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/repo.ts",
      [
        "export class Repo {",
        "  find(id: string): number",
        "  find(id: number): number",
        "  find(id: unknown): number {",
        "    return lookup(id)",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/merged.ts",
      [
        "export namespace N {",
        "  export const a = 1",
        "}",
        "export namespace N {",
        "  export const b = 2",
        "}",
        "export class C {}",
        "export namespace C {",
        "  export const c = 3",
        "}",
        "",
      ].join("\n"),
    )
    const result = await scanTypeScript(workspace.root)
    const ids = result.ir.symbols.map((symbol) => symbol.id)

    expect(result.skipped).toEqual([])
    expect(result.extractionFailures).toEqual([])
    expect(new Set(ids).size).toBe(ids.length)
    expect(() => assertIRIntegrity(result.ir)).not.toThrow()
  })
})
