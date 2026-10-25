import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common"
import { CreateOrderDto } from "./create-order.dto"
import { OrdersService } from "./orders.service"

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.orders.create(dto)
  }

  @Get()
  list(@Query("customerId") customerId: string) {
    return this.orders.list(customerId)
  }

  @Get(":id")
  async read(@Param("id") id: string) {
    const order = await this.orders.find(id)
    if (order === null) throw new Error(`order not found: ${id}`)
    return order
  }

  @Post(":id/cancel")
  cancel(@Param("id") id: string) {
    return this.orders.cancel(id)
  }

  @Delete(":id")
  purge(@Param("id") id: string) {
    return this.orders.purge(id)
  }
}
