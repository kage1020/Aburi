import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { hasPrismaImport } from "../src/index"

const PATH = "src/service.ts"

function edge(source: string, line = 1): ImportEdge {
  return { source, symbols: ["PrismaClient"], line, dynamic: false }
}

describe("hasPrismaImport", () => {
  it.each([
    ["@prisma/client", [edge("@prisma/client")]],
    ["the Edge runtime entry @prisma/client/edge", [edge("@prisma/client/edge")]],
    ["@prisma/client beside other imports", [edge("react", 1), edge("@prisma/client", 2)]],
  ])("returns true when the file imports %s", (_label, imports) => {
    expect(hasPrismaImport(imports, PATH)).toBe(true)
  })

  it.each([
    ["nothing", []],
    ["unrelated ORMs", [edge("drizzle-orm", 1), edge("typeorm", 2)]],
    ["lookalike specifiers", [edge("@prisma/client-edge", 1), edge("@my-org/prisma-client", 2)]],
  ])("returns false when the file imports %s", (_label, imports) => {
    expect(hasPrismaImport(imports, PATH)).toBe(false)
  })

  it("throws on an empty ImportEdge.source, naming the plugin, the file, and the line", () => {
    expect(() => hasPrismaImport([edge("", 9)], PATH)).toThrow(
      `effects-prisma (${PATH}, line 9): ImportEdge.source is empty`,
    )
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    expect(() => hasPrismaImport([edge("@prisma/client", 1), edge("", 2)], PATH)).toThrow(
      /ImportEdge\.source is empty/,
    )
  })
})
