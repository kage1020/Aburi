import { describe, expect, it } from "vitest"
import { hasPrismaImport } from "../src/index"

describe("hasPrismaImport", () => {
  it("returns true when the file imports @prisma/client", () => {
    expect(
      hasPrismaImport([
        { source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false },
      ]),
    ).toBe(true)
  })

  it("returns false when the import list is empty", () => {
    expect(hasPrismaImport([])).toBe(false)
  })

  it("returns false when the file imports an unrelated ORM", () => {
    expect(
      hasPrismaImport([
        { source: "drizzle-orm", symbols: ["*"], line: 1, dynamic: false },
        { source: "typeorm", symbols: ["DataSource"], line: 2, dynamic: false },
      ]),
    ).toBe(false)
  })

  it("returns false when the source string is a similar-looking substring, not the actual module", () => {
    expect(
      hasPrismaImport([
        { source: "@prisma/client-edge", symbols: ["*"], line: 1, dynamic: false },
        { source: "@my-org/prisma-client", symbols: ["*"], line: 2, dynamic: false },
      ]),
    ).toBe(false)
  })

  it("returns true when @prisma/client sits alongside other imports", () => {
    expect(
      hasPrismaImport([
        { source: "react", symbols: ["useState"], line: 1, dynamic: false },
        { source: "@prisma/client", symbols: ["PrismaClient"], line: 2, dynamic: false },
        { source: "zod", symbols: ["z"], line: 3, dynamic: false },
      ]),
    ).toBe(true)
  })
})
