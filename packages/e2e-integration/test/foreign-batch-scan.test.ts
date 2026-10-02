import { drizzleEffectsPlugin } from "@aburi/effects-drizzle"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith, symbolNamed } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * Another library's zero-argument `batch()` or `transaction()` must not cost a Drizzle file
 * its Symbols.
 *
 * The Drizzle import gate is file-wide, so in a script that copies Firestore into Postgres
 * `firestore.batch()` reaches the Drizzle classifier. Drizzle's `batch` and `transaction`
 * both take an argument, so the call is not Drizzle's: it stays in `calls[]` while the
 * function keeps the `db.read` its Drizzle query carries.
 */

const workspace = useScratchWorkspace("foreign-batch")

describe("scan — a Firestore batch beside a Drizzle query", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/migrate.ts",
      [
        `import { eq } from "drizzle-orm"`,
        `import { Firestore } from "@google-cloud/firestore"`,
        `import { db } from "./db"`,
        `import { users } from "./schema"`,
        ``,
        `const firestore = new Firestore()`,
        ``,
        `export async function copyUsers(ids: string[]) {`,
        `  const batch = firestore.batch()`,
        `  for (const id of ids) {`,
        `    const [row] = await db.select().from(users).where(eq(users.id, id))`,
        `    batch.set(firestore.doc(\`users/\${id}\`), row)`,
        `  }`,
        `  await batch.commit()`,
        `}`,
        ``,
        `export async function openTransaction(sequelize: { transaction(): Promise<unknown> }) {`,
        `  return sequelize.transaction()`,
        `}`,
        ``,
      ].join("\n"),
    )
  })

  it("keeps the file's Symbols, the Drizzle read, and the foreign calls", async () => {
    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      effects: [drizzleEffectsPlugin],
    })
    expect(result.skipped).toEqual([])

    const copyUsers = symbolNamed(result, "copyUsers")
    expect(copyUsers.effects.map((effect) => effect.id)).toEqual(["db.read"])
    expect(copyUsers.calls.map((call) => call.target)).toContain("firestore.batch")

    const openTransaction = symbolNamed(result, "openTransaction")
    expect(openTransaction.effects).toEqual([])
    expect(openTransaction.calls.map((call) => call.target)).toContain("sequelize.transaction")
  })
})
