import { drizzle } from "drizzle-orm/node-postgres"

export type Database = ReturnType<typeof drizzle>

export const database: Database = drizzle(process.env.DATABASE_URL ?? "")
