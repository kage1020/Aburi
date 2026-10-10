import { eq } from "drizzle-orm"
import express from "express"
import { db, users } from "./db"
import { requireAdmin } from "./middleware"

export const router = express.Router()

router.get("/users", requireAdmin, async (_req, res) => {
  res.json(await db.select().from(users))
})

router.get("/users/:id", async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.params.id))
  res.json(user ?? null)
})
