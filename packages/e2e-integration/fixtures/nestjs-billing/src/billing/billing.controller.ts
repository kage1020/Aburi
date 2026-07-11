import { Body, Controller, Get, Param, Post } from "@nestjs/common"
import { BillingService } from "./billing.service"
import { CreateInvoiceDto } from "./dto/create-invoice.dto"

@Controller("billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post("invoices")
  create(@Body() dto: CreateInvoiceDto) {
    return this.billing.createInvoice(dto)
  }

  @Get("invoices/:id")
  read(@Param("id") id: string) {
    const invoice = this.billing.findInvoice(id)
    if (invoice === undefined) throw new Error(`invoice not found: ${id}`)
    return invoice
  }

  @Post("invoices/:id/send")
  send(@Param("id") id: string) {
    return this.billing.markSent(id)
  }
}
