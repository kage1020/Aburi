export interface PaymentsRouter {
  payments: {
    charge: { orderId: string; amountCents: number }
    refund: { paymentId: string }
    status: { paymentId: string }
  }
}
