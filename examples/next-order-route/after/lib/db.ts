import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

export function recentOrders() {
  return prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 20 })
}

export function createOrder(data: { customerId: string; totalCents: number }) {
  return prisma.order.create({ data: { ...data, source: "api" } })
}

export function recordAudit(action: string, orderId: string) {
  return prisma.auditLog.create({ data: { action, orderId } })
}

export function findSession(token: string) {
  return prisma.session.findUnique({ where: { token }, include: { user: true } })
}
