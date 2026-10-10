import { assertIRIntegrity } from "@aburi/core"
import { scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/index"

const workspace = useScratchWorkspace("merged-declarations")

const scanWorkspace = () => scanWith(workspace.root, { languages: [langTypescriptPlugin] })

describe("scan — a workspace whose entities are declared more than once", () => {
  beforeEach(async () => {
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
  })

  it("finishes and produces a document that passes every integrity invariant", async () => {
    const result = await scanWorkspace()

    expect(result.skipped).toEqual([])
    expect(result.extractionFailures).toEqual([])
    expect(() => assertIRIntegrity(result.ir)).not.toThrow()
  })

  it("gives each entity one Symbol", async () => {
    const result = await scanWorkspace()
    const ids = result.ir.symbols.map((symbol) => symbol.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("ts:src/box.ts#Box.value")
    expect(ids).toContain("ts:src/repo.ts#Repo.find")
    expect(ids).toContain("ts:src/merged.ts#N")
  })

  it("keeps what the further declarations declared", async () => {
    const result = await scanWorkspace()
    const ids = result.ir.symbols.map((symbol) => symbol.id)

    expect(ids).toContain("ts:src/merged.ts#N.a")
    expect(ids).toContain("ts:src/merged.ts#N.b")
    expect(ids).toContain("ts:src/merged.ts#C::c")
  })

  it("records the setter's call on the property the getter named", async () => {
    const result = await scanWorkspace()
    const value = result.ir.symbols.find((symbol) => symbol.id === "ts:src/box.ts#Box.value")

    expect(value?.derivedBy).toContain("accessor-declaration")
    expect(value?.derivedBy).toContain("declaration-merged")
    expect(value?.calls?.map((c) => c.target)).toContain("audit")
    expect(value?.dropped).toBe(false)
  })
})

describe("scan — a call through the name of a class a namespace merged into", () => {
  it("reaches the namespace's export, the member TypeScript calls", async () => {
    await workspace.writeSource(
      "src/c.ts",
      [
        "export class C {",
        "  m(n: number) {",
        "    return n",
        "  }",
        "}",
        "export namespace C {",
        "  export function m(n: number) {",
        "    return helper(n)",
        "  }",
        "}",
        "export function f() {",
        "  return C.m(1)",
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/g.ts",
      ["import { C } from './c'", "export function g() {", "  return C.m(2)", "}", ""].join("\n"),
    )

    const result = await scanWorkspace()
    const resolved = (id: string) =>
      result.ir.symbols.find((symbol) => symbol.id === id)?.calls.map((call) => call.resolved)

    expect(resolved("ts:src/c.ts#f")).toEqual(["ts:src/c.ts#C::m"])
    expect(resolved("ts:src/g.ts#g")).toEqual(["ts:src/c.ts#C::m"])
  })
})
