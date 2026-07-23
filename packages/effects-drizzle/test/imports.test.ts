import { describe, expect, it } from "vitest"
import { hasDrizzleImport } from "../src/index"

describe("hasDrizzleImport", () => {
  it("returns true when the file imports drizzle-orm directly", () => {
    expect(
      hasDrizzleImport([{ source: "drizzle-orm", symbols: ["sql"], line: 1, dynamic: false }]),
    ).toBe(true)
  })

  it.each([
    "drizzle-orm/node-postgres",
    "drizzle-orm/postgres-js",
    "drizzle-orm/mysql2",
    "drizzle-orm/better-sqlite3",
    "drizzle-orm/bun-sqlite",
    "drizzle-orm/neon-http",
    "drizzle-orm/neon-serverless",
    "drizzle-orm/d1",
    "drizzle-orm/planetscale-serverless",
    "drizzle-orm/libsql",
    "drizzle-orm/vercel-postgres",
    "drizzle-orm/xata-http",
    "drizzle-orm/expo-sqlite",
  ])("returns true for driver subpath %s", (source) => {
    expect(hasDrizzleImport([{ source, symbols: ["drizzle"], line: 1, dynamic: false }])).toBe(true)
  })

  it("returns false when the import list is empty", () => {
    expect(hasDrizzleImport([])).toBe(false)
  })

  it("returns false when the file imports an unrelated ORM", () => {
    expect(
      hasDrizzleImport([
        { source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false },
        { source: "typeorm", symbols: ["DataSource"], line: 2, dynamic: false },
      ]),
    ).toBe(false)
  })

  it("returns false for lookalike specifiers that are not real drizzle-orm modules", () => {
    // `drizzle` (bare, no `-orm`) is a different package.
    // `drizzle-orm-mock` / `drizzle-orm-lite` are third-party lookalikes — the trailing
    // slash in the subpath check prevents them from matching.
    // `@drizzle/kit` is drizzle-kit (the CLI), not drizzle-orm — no runtime call surface.
    expect(
      hasDrizzleImport([
        { source: "drizzle", symbols: ["*"], line: 1, dynamic: false },
        { source: "drizzle-orm-mock", symbols: ["*"], line: 2, dynamic: false },
        { source: "not-drizzle-orm", symbols: ["*"], line: 3, dynamic: false },
        { source: "@drizzle/kit", symbols: ["*"], line: 4, dynamic: false },
      ]),
    ).toBe(false)
  })

  it("returns true when drizzle-orm sits alongside other imports", () => {
    expect(
      hasDrizzleImport([
        { source: "react", symbols: ["useState"], line: 1, dynamic: false },
        { source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 2, dynamic: false },
        { source: "zod", symbols: ["z"], line: 3, dynamic: false },
      ]),
    ).toBe(true)
  })

  it("throws when the language plugin emits an empty ImportEdge.source", () => {
    // ImportEdge.source is contract-guaranteed to be normalized and non-empty. Getting
    // `""` here means the upstream language plugin failed to normalize — silently
    // returning false would mask the bug.
    expect(() =>
      hasDrizzleImport([{ source: "", symbols: ["sql"], line: 1, dynamic: false }]),
    ).toThrow(/ImportEdge\.source is empty/)
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    // Order-independence pin — using `.some()` alone would short-circuit on the first
    // match and silently accept a broken edge later in the list.
    expect(() =>
      hasDrizzleImport([
        { source: "drizzle-orm", symbols: ["sql"], line: 1, dynamic: false },
        { source: "", symbols: ["x"], line: 2, dynamic: false },
      ]),
    ).toThrow(/ImportEdge\.source is empty/)
  })
})
