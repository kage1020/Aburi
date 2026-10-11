import { NextResponse } from "next/server"
import { auth } from "../../../lib/auth"
import { createOrder, recentOrders } from "../../../lib/db"

export async function GET() {
  return NextResponse.json(await recentOrders())
}

export async function POST(req: Request) {
  const session = await auth()
  if (session?.user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }
  const order = await createOrder(await req.json())
  return NextResponse.json(order, { status: 201 })
}
