import { Body, Controller, Get, Param, Post } from "@nestjs/common"
import { InvoicesService } from "./invoices.service"

@Controller("invoices")
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.invoices.findOne(id)
  }

  @Post()
  create(@Body() body: { customerId: string; amountCents: number }) {
    return this.invoices.create(body.customerId, body.amountCents)
  }
}
