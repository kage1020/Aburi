import { Injectable } from "@nestjs/common"
import { PrismaClient } from "@prisma/client"

@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaClient) {}

  findOne(id: string) {
    return this.prisma.invoice.findUniqueOrThrow({ where: { id } })
  }

  create(customerId: string, amountCents: number) {
    return this.prisma.invoice.create({ data: { customerId, amountCents, status: "draft" } })
  }
}
