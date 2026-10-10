import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { hasDrizzleImport } from "../src/index"

const PATH = "src/service.ts"

function edge(source: string, line = 1, symbols: string[] = ["drizzle"]): ImportEdge {
  return { source, symbols, line, dynamic: false }
}

describe("hasDrizzleImport", () => {
  it.each([
    ["drizzle-orm", [edge("drizzle-orm")]],
    ["a driver subpath", [edge("drizzle-orm/postgres-js")]],
    ["a multi-segment subpath", [edge("drizzle-orm/aws-data-api/pg")]],
    ["drizzle-orm for its side effects only", [edge("drizzle-orm", 1, [])]],
    ["drizzle-orm beside other imports", [edge("react", 1), edge("drizzle-orm/d1", 2)]],
  ])("returns true when the file imports %s", (_label, imports) => {
    expect(hasDrizzleImport(imports, PATH)).toBe(true)
  })

  it.each([
    ["nothing", []],
    ["unrelated ORMs", [edge("@prisma/client", 1), edge("typeorm", 2)]],
    [
      "lookalike specifiers",
      [
        edge("drizzle", 1),
        edge("drizzle-orm-mock", 2),
        edge("not-drizzle-orm", 3),
        edge("@drizzle/kit", 4),
      ],
    ],
  ])("returns false when the file imports %s", (_label, imports) => {
    expect(hasDrizzleImport(imports, PATH)).toBe(false)
  })

  it("throws on an empty ImportEdge.source, naming the plugin, the file, and the line", () => {
    expect(() => hasDrizzleImport([edge("", 3)], PATH)).toThrow(
      `effects-drizzle (${PATH}, line 3): ImportEdge.source is empty`,
    )
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    expect(() => hasDrizzleImport([edge("drizzle-orm", 1), edge("", 2)], PATH)).toThrow(
      /ImportEdge\.source is empty/,
    )
  })
})
