import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { drizzleEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("foreign-calls")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [drizzleEffectsPlugin] })

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
        `export async function renameUser(id: string, name: string) {`,
        `  await db.transaction(async (tx) => {`,
        `    await tx.update(users).set({ name }).where(eq(users.id, id))`,
        `  })`,
        `}`,
        ``,
      ].join("\n"),
    )
  })

  it("keeps the file's Symbols, the Drizzle read, and the foreign calls", async () => {
    const result = await scanWorkspace()
    expect(result.extractionFailures).toEqual([])
    expect(result.skipped).toEqual([])

    const copyUsers = symbolNamed(result, "copyUsers")
    expect(
      copyUsers.effects.map((e) => ({ id: e.id, target: e.target, confidence: e.confidence })),
    ).toEqual([{ id: "db.read", target: "db.select", confidence: "high" }])
    const targets = copyUsers.calls.map((call) => call.target)
    expect(targets).toContain("firestore.batch")
    expect(targets).not.toContain("db.select")

    const renameUser = symbolNamed(result, "renameUser")
    expect(
      renameUser.effects
        .filter((e) => e.id === "db.transaction")
        .map((e) => ({ id: e.id, target: e.target, confidence: e.confidence })),
    ).toEqual([{ id: "db.transaction", target: "db.transaction", confidence: "high" }])

    const openTransaction = symbolNamed(result, "openTransaction")
    expect(openTransaction.effects).toEqual([])
    expect(openTransaction.calls.map((call) => call.target)).toContain("sequelize.transaction")
  })
})

describe("scan — a zero-argument update() and delete() beside a Drizzle write", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/profile-form.ts",
      [
        `import { eq } from "drizzle-orm"`,
        `import { db } from "./db"`,
        `import { users } from "./schema"`,
        ``,
        `export class ProfileForm {`,
        `  update() {}`,
        ``,
        `  reset() {`,
        `    this.update()`,
        `  }`,
        ``,
        `  async rename(id: string, name: string) {`,
        `    await db.update(users).set({ name }).where(eq(users.id, id))`,
        `  }`,
        `}`,
        ``,
        `export function discardDraft(form: { delete(): void }) {`,
        `  form.delete()`,
        `}`,
        ``,
        `export function cancelEdit(form: { delete(): void }) {`,
        `  discardDraft(form)`,
        `}`,
        ``,
      ].join("\n"),
    )
  })

  it("keeps them as calls, with no write on their functions or the callers", async () => {
    const result = await scanWorkspace()
    expect(result.extractionFailures).toEqual([])
    expect(result.skipped).toEqual([])

    const reset = symbolNamed(result, "ProfileForm.reset")
    expect(reset.effects).toEqual([])
    expect(reset.calls.map((call) => call.target)).toContain("this.update")

    const discardDraft = symbolNamed(result, "discardDraft")
    expect(discardDraft.effects).toEqual([])
    expect(discardDraft.calls.map((call) => call.target)).toContain("form.delete")

    // The caller resolves to `discardDraft`, so a write recorded there would propagate here.
    const cancelEdit = symbolNamed(result, "cancelEdit")
    expect(cancelEdit.calls.map((call) => call.resolved)).toContain(discardDraft.id)
    expect(cancelEdit.effects).toEqual([])

    const rename = symbolNamed(result, "ProfileForm.rename")
    expect(
      rename.effects.map((e) => ({ id: e.id, target: e.target, confidence: e.confidence })),
    ).toEqual([{ id: "db.write", target: "db.update", confidence: "high" }])
  })
})

describe("scan — Express routes beside a Drizzle write", () => {
  it("leaves a route registration, its path quoted or in backticks, as a call", async () => {
    await workspace.writeSource(
      "src/routes/users.ts",
      [
        `import { drizzle } from "drizzle-orm/postgres-js"`,
        `import type { Router } from "express"`,
        `import { users } from "./schema"`,
        ``,
        `export function mountUserRoutes(router: Router, db: ReturnType<typeof drizzle>) {`,
        `  router.delete("/users/:id", async (req, res) => {`,
        `    await db.delete(users)`,
        `    res.json({ ok: true })`,
        `  })`,
        `  router.delete(\`/users/:id/sessions\`, async (req, res) => {`,
        `    res.json({ ok: true })`,
        `  })`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const mount = symbolNamed(result, "mountUserRoutes")

    expect(mount.effects).toMatchObject([
      { id: "db.write", target: "db.delete", confidence: "high" },
    ])
    expect(mount.calls.filter((call) => call.target === "router.delete")).toHaveLength(2)
  })
})
