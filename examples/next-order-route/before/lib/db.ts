import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

export function recentOrders() {
  return prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 20 })
}

export function createOrder(data: { customerId: string; totalCents: number }) {
  return prisma.order.create({ data })
}

export function findSession(token: string) {
  return prisma.session.findUnique({ where: { token }, include: { user: true } })
}
