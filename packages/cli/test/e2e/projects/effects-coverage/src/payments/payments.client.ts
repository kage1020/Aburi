import { Injectable } from "@nestjs/common"
import { createTRPCClient, httpBatchLink } from "@trpc/client"
import type { PaymentsRouter } from "./payments.router"

const client = createTRPCClient<PaymentsRouter>({
  links: [httpBatchLink({ url: process.env.PAYMENTS_URL ?? "http://payments/trpc" })],
})

@Injectable()
export class PaymentsClient {
  async charge(orderId: string, amountCents: number) {
    return await client.payments.charge.mutate({ orderId, amountCents })
  }

  async refund(paymentId: string) {
    return await client.payments.refund.mutate({ paymentId })
  }

  async status(paymentId: string) {
    return await client.payments.status.query({ paymentId })
  }
}
