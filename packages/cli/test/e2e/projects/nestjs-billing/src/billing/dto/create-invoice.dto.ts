export class CreateInvoiceDto {
  customerId!: string
  amountCents!: number
  currency!: string
  dueAt!: string
  memo?: string
}
