import type { DropHint } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  classifySymbolDropHint,
  extractSymbols,
  parseTypescriptFile,
  TYPESCRIPT_FILE_DROP_PATTERNS,
} from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

async function hintOf(source: string, suffix: string): Promise<DropHint | null> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const symbols = extractSymbols(requireTree(result.tree), ctx)
  const target = symbols.find((s) => s.id.endsWith(suffix))
  if (target === undefined) {
    throw new Error(
      `no symbol with id ending in "${suffix}"; have: ${symbols.map((s) => s.id).join(", ")}`,
    )
  }
  return classifySymbolDropHint(target, ctx)
}

describe("classifySymbolDropHint", () => {
  it("marks an interface as Category B with 'interface (data model)'", async () => {
    expect(await hintOf("export interface Invoice { total: number }", "#Invoice")).toEqual({
      reason: "interface (data model)",
      category: "B",
    })
  })

  it("marks a type alias as Category B with 'type alias'", async () => {
    expect(await hintOf("export type Amount = number", "#Amount")).toEqual({
      reason: "type alias",
      category: "B",
    })
  })

  it("marks a class with only field declarations as pure DTO", async () => {
    expect(await hintOf("export class Invoice { total: number = 0 }", "#Invoice")).toEqual({
      reason: "pure DTO",
      category: "B",
    })
  })

  it("marks a class with only static readonly literal fields as pure constants", async () => {
    expect(
      await hintOf(
        "export class Constants { static readonly PI = 3.14; static readonly E = 2.72 }",
        "#Constants",
      ),
    ).toEqual({ reason: "pure constants", category: "B" })
  })

  it("does not mark a class with a method as pure DTO", async () => {
    expect(
      await hintOf("export class InvoiceService { create() { return 1 } }", "#InvoiceService"),
    ).toBeNull()
  })

  it("marks an empty function as Category B with 'empty body'", async () => {
    expect(await hintOf("export function noop() {}", "#noop")).toEqual({
      reason: "empty body",
      category: "B",
    })
  })

  it("exposes the TypeScript-specific file drop patterns", () => {
    expect(TYPESCRIPT_FILE_DROP_PATTERNS).toContain("**/*.d.ts")
    expect(TYPESCRIPT_FILE_DROP_PATTERNS).toContain("**/*.d.mts")
    expect(TYPESCRIPT_FILE_DROP_PATTERNS).toContain("**/*.d.cts")
  })
})
