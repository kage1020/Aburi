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

  it("returns true when the file imports @prisma/client/edge (Vercel Edge / Cloudflare Workers)", () => {
    expect(
      hasPrismaImport([
        { source: "@prisma/client/edge", symbols: ["PrismaClient"], line: 1, dynamic: false },
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

  it("returns false for lookalike specifiers that are not real Prisma modules", () => {
    // `@prisma/client-edge` (hyphen) does not exist — the real Edge entry uses a slash.
    // A different-organization fork under `@my-org/prisma-client` is a third-party
    // package we cannot assume is Prisma-shaped, so it stays unmatched.
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

  it("throws when the language plugin emits an empty ImportEdge.source", () => {
    // ImportEdge.source is contract-guaranteed to be normalized and non-empty. Getting
    // `""` here means the upstream language plugin failed to normalize — silently
    // returning false would mask the bug.
    expect(() =>
      hasPrismaImport([{ source: "", symbols: ["PrismaClient"], line: 1, dynamic: false }]),
    ).toThrow(/ImportEdge\.source is empty/)
  })
})
