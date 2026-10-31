import { Injectable } from "@nestjs/common"
import { eq } from "drizzle-orm"
import { type Database, database } from "../db/drizzle"
import { auditLog } from "../db/schema"

@Injectable()
export class AuditRepository {
  private readonly db: Database = database

  async record(orderId: string, action: string) {
    await this.db.insert(auditLog).values({ orderId, action })
  }

  async history(orderId: string) {
    return await this.db.select().from(auditLog).where(eq(auditLog.orderId, orderId))
  }

  async forget(orderId: string) {
    await this.db.delete(auditLog).where(eq(auditLog.orderId, orderId))
  }
}
