import { PrismaClient } from "@prisma/client"

export const prisma = new PrismaClient()

export interface Context {
  session: { user?: { id: string } } | null
}
