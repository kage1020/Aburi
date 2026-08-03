import { describe, expect, it } from "vitest"
import { hasPrismaImport } from "../src/index"

const PATH = "src/service.ts"

describe("hasPrismaImport", () => {
  it("returns true when the file imports @prisma/client", () => {
    expect(
      hasPrismaImport(
        [{ source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false }],
        PATH,
      ),
    ).toBe(true)
  })

  it("returns true when the file imports @prisma/client/edge (Vercel Edge / Cloudflare Workers)", () => {
    expect(
      hasPrismaImport(
        [{ source: "@prisma/client/edge", symbols: ["PrismaClient"], line: 1, dynamic: false }],
        PATH,
      ),
    ).toBe(true)
  })

  it("returns false when the import list is empty", () => {
    expect(hasPrismaImport([], PATH)).toBe(false)
  })

  it("returns false when the file imports an unrelated ORM", () => {
    expect(
      hasPrismaImport(
        [
          { source: "drizzle-orm", symbols: ["*"], line: 1, dynamic: false },
          { source: "typeorm", symbols: ["DataSource"], line: 2, dynamic: false },
        ],
        PATH,
      ),
    ).toBe(false)
  })

  it("returns false for lookalike specifiers that are not real Prisma modules", () => {
    // `@prisma/client-edge` (hyphen) does not exist — the real Edge entry uses a slash.
    // A different-organization fork under `@my-org/prisma-client` is a third-party
    // package we cannot assume is Prisma-shaped, so it stays unmatched.
    expect(
      hasPrismaImport(
        [
          { source: "@prisma/client-edge", symbols: ["*"], line: 1, dynamic: false },
          { source: "@my-org/prisma-client", symbols: ["*"], line: 2, dynamic: false },
        ],
        PATH,
      ),
    ).toBe(false)
  })

  it("returns true when @prisma/client sits alongside other imports", () => {
    expect(
      hasPrismaImport(
        [
          { source: "react", symbols: ["useState"], line: 1, dynamic: false },
          { source: "@prisma/client", symbols: ["PrismaClient"], line: 2, dynamic: false },
          { source: "zod", symbols: ["z"], line: 3, dynamic: false },
        ],
        PATH,
      ),
    ).toBe(true)
  })

  it("throws when the language plugin emits an empty ImportEdge.source", () => {
    // ImportEdge.source is contract-guaranteed to be normalized and non-empty. Getting
    // `""` here means the upstream language plugin failed to normalize — silently
    // returning false would mask the bug.
    expect(() =>
      hasPrismaImport([{ source: "", symbols: ["PrismaClient"], line: 1, dynamic: false }], PATH),
    ).toThrow(/ImportEdge\.source is empty/)
  })

  it("names the plugin, the file, and the offending line in the thrown message", () => {
    // `filePath` is the whole reason the parameter exists — an assertion on the
    // "is empty" text alone would pass against an implementation that ignored it.
    expect(() =>
      hasPrismaImport([{ source: "", symbols: ["PrismaClient"], line: 9, dynamic: false }], PATH),
    ).toThrow(`effects-prisma (${PATH}, line 9): ImportEdge.source is empty`)
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    // Order-independence pin — using `.some()` alone would short-circuit on the first
    // match and silently accept a broken edge later in the list.
    expect(() =>
      hasPrismaImport(
        [
          { source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false },
          { source: "", symbols: ["x"], line: 2, dynamic: false },
        ],
        PATH,
      ),
    ).toThrow(/ImportEdge\.source is empty/)
  })
})
