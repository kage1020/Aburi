import { NextResponse } from "next/server"
import { createOrder, recentOrders, recordAudit } from "../../../lib/db"

export async function GET() {
  return NextResponse.json(await recentOrders())
}

export async function POST(req: Request) {
  const order = await createOrder(await req.json())
  await recordAudit("order.create", order.id)
  return NextResponse.json(order, { status: 201 })
}
