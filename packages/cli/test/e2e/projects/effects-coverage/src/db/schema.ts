import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const auditLog = pgTable("audit_log", {
  id: integer("id").primaryKey(),
  orderId: text("order_id").notNull(),
  action: text("action").notNull(),
  at: timestamp("at").defaultNow(),
})
