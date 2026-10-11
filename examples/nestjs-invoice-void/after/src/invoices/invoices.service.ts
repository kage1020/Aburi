import { Injectable } from "@nestjs/common"
import { EventEmitter2 } from "@nestjs/event-emitter"
import { PrismaClient } from "@prisma/client"

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly events: EventEmitter2,
  ) {}

  findOne(id: string) {
    return this.prisma.invoice.findUniqueOrThrow({ where: { id } })
  }

  create(customerId: string, amountCents: number, dueAt: Date) {
    return this.prisma.invoice.create({
      data: { customerId, amountCents, dueAt, status: "draft" },
    })
  }

  async void(id: string) {
    const invoice = await this.prisma.invoice.update({ where: { id }, data: { status: "void" } })
    this.events.emit("invoice.voided", { id })
    return invoice
  }
}
