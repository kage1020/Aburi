import { Injectable } from "@nestjs/common"
import { EventEmitter2 } from "@nestjs/event-emitter"
import { PrismaClient } from "@prisma/client"
import { AuditRepository } from "../audit/audit.repository"
import { PaymentsClient } from "../payments/payments.client"
import type { CreateOrderDto } from "./create-order.dto"

const prisma = new PrismaClient()

@Injectable()
export class OrdersService {
  constructor(
    private readonly audit: AuditRepository,
    private readonly payments: PaymentsClient,
    private readonly eventBus: EventEmitter2,
  ) {}

  async create(dto: CreateOrderDto) {
    if (dto.amountCents <= 0) throw new Error("an order must cost something")
    const order = await prisma.order.create({ data: dto })
    const payment = await this.payments.charge(order.id, dto.amountCents)
    await prisma.order.update({ where: { id: order.id }, data: { paymentId: payment.id } })
    await this.audit.record(order.id, "created")
    this.eventBus.emit("order.created", { orderId: order.id })
    return order
  }

  async find(id: string) {
    return await prisma.order.findUnique({ where: { id } })
  }

  async list(customerId: string) {
    return await prisma.order.findMany({ where: { customerId } })
  }

  async cancel(id: string) {
    const order = await prisma.order.findUniqueOrThrow({ where: { id } })
    if (order.paymentId !== null) await this.payments.refund(order.paymentId)
    await prisma.$transaction([
      prisma.order.update({ where: { id }, data: { status: "cancelled" } }),
      prisma.orderLine.deleteMany({ where: { orderId: id } }),
    ])
    await this.audit.record(id, "cancelled")
    this.eventBus.emit("order.cancelled", { orderId: id })
  }

  async purge(id: string) {
    await prisma.order.delete({ where: { id } })
    await this.audit.forget(id)
  }
}
