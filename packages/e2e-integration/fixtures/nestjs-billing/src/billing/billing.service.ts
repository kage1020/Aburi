import { Injectable } from "@nestjs/common"
import { LoggerService } from "../common/logger.service"
import { CreateInvoiceDto } from "./dto/create-invoice.dto"

interface StoredInvoice {
  id: string
  customerId: string
  amountCents: number
  currency: string
  dueAt: string
  memo?: string
  status: "draft" | "sent" | "paid" | "void"
}

@Injectable()
export class BillingService {
  private readonly invoices: StoredInvoice[] = []

  constructor(private readonly logger: LoggerService) {}

  createInvoice(dto: CreateInvoiceDto): StoredInvoice {
    const invoice: StoredInvoice = {
      id: `inv-${this.invoices.length + 1}`,
      customerId: dto.customerId,
      amountCents: dto.amountCents,
      currency: dto.currency,
      dueAt: dto.dueAt,
      status: "draft",
    }
    if (dto.memo !== undefined) invoice.memo = dto.memo
    this.invoices.push(invoice)
    this.logger.info(`invoice created ${invoice.id}`)
    return invoice
  }

  findInvoice(id: string): StoredInvoice | undefined {
    return this.invoices.find((invoice) => invoice.id === id)
  }

  listInvoices(customerId?: string): StoredInvoice[] {
    if (customerId === undefined) return [...this.invoices]
    return this.invoices.filter((invoice) => invoice.customerId === customerId)
  }

  markSent(id: string): StoredInvoice {
    const invoice = this.findInvoice(id)
    if (invoice === undefined) throw new Error(`invoice not found: ${id}`)
    invoice.status = "sent"
    this.logger.info(`invoice sent ${invoice.id}`)
    return invoice
  }

  markPaid(id: string): StoredInvoice {
    const invoice = this.findInvoice(id)
    if (invoice === undefined) throw new Error(`invoice not found: ${id}`)
    invoice.status = "paid"
    this.logger.info(`invoice paid ${invoice.id}`)
    return invoice
  }

  voidInvoice(id: string): StoredInvoice {
    const invoice = this.findInvoice(id)
    if (invoice === undefined) throw new Error(`invoice not found: ${id}`)
    invoice.status = "void"
    this.logger.warn(`invoice voided ${invoice.id}`)
    return invoice
  }

  totalDue(customerId: string): number {
    const outstanding = this.listInvoices(customerId).filter(
      (invoice) => invoice.status === "sent" || invoice.status === "draft",
    )
    let sum = 0
    for (const invoice of outstanding) sum += invoice.amountCents
    return sum
  }

  computeLateFee(id: string, todayIso: string): number {
    const invoice = this.findInvoice(id)
    if (invoice === undefined) throw new Error(`invoice not found: ${id}`)
    const dueAt = Date.parse(invoice.dueAt)
    const today = Date.parse(todayIso)
    if (today <= dueAt) return 0
    const daysLate = Math.floor((today - dueAt) / (24 * 60 * 60 * 1000))
    return Math.min(daysLate * 100, invoice.amountCents)
  }

  applyRefund(id: string, amountCents: number): StoredInvoice {
    const invoice = this.findInvoice(id)
    if (invoice === undefined) throw new Error(`invoice not found: ${id}`)
    invoice.amountCents -= amountCents
    this.logger.info(`refund applied ${invoice.id} ${amountCents}`)
    return invoice
  }

  archiveOldInvoices(cutoffIso: string): number {
    const cutoff = Date.parse(cutoffIso)
    const before = this.invoices.length
    for (let i = this.invoices.length - 1; i >= 0; i--) {
      const invoice = this.invoices[i]
      if (invoice !== undefined && Date.parse(invoice.dueAt) < cutoff) {
        this.invoices.splice(i, 1)
      }
    }
    return before - this.invoices.length
  }

  countByStatus(status: StoredInvoice["status"]): number {
    let count = 0
    for (const invoice of this.invoices) {
      if (invoice.status === status) count++
    }
    return count
  }

  renumber(): void {
    for (let i = 0; i < this.invoices.length; i++) {
      const invoice = this.invoices[i]
      if (invoice !== undefined) invoice.id = `inv-${i + 1}`
    }
  }
}
