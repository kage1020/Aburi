import { drizzle } from "drizzle-orm/node-postgres"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  deletedAt: timestamp("deleted_at"),
})

export const db = drizzle(process.env.DATABASE_URL ?? "")
