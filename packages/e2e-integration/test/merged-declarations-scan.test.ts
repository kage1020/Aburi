import { assertIRIntegrity } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * The symptom as it was reported: a class with a getter and a setter, and a scan that ends
 * with `[#1] ts:src/box.ts#Box.value: duplicate Symbol id` and no document.
 *
 * Integrity ran once over the whole IR at the end of the scan, outside the per-file boundary,
 * so this was not one file's problem — every other file in the workspace went with it. The
 * same held for an overload beside its implementation and for a reopened namespace. The scan
 * decides invariant #1 per file now, so the blast radius would be `box.ts` alone; what these
 * tests hold is the fix upstream of that, where the pair is one Symbol and no file is lost.
 */

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

    // The second `namespace N` and the namespace merged into `class C` are where a rule that
    // dropped a repeated declaration outright would show: the Symbol survives and everything
    // written inside it disappears.
    expect(ids).toContain("ts:src/merged.ts#N.a")
    expect(ids).toContain("ts:src/merged.ts#N.b")
    expect(ids).toContain("ts:src/merged.ts#C.c")
  })

  it("records the setter's call on the property the getter named", async () => {
    const result = await scanWorkspace()
    const value = result.ir.symbols.find((symbol) => symbol.id === "ts:src/box.ts#Box.value")

    expect(value?.derivedBy).toContain("accessor-declaration")
    expect(value?.derivedBy).toContain("declaration-merged")
    expect(value?.calls?.map((c) => c.target)).toContain("audit")
    // The getter's body is `return this.#v` and the setter's is where the work is, so a
    // Symbol described by its leading declaration alone would be dropped.
    expect(value?.dropped).toBe(false)
  })
})
