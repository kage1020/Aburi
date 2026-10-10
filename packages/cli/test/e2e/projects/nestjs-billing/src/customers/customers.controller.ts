import { Controller, Get, Param, Post, Query } from "@nestjs/common"
import { CustomersService } from "./customers.service"

@Controller("customers")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  create(@Query("name") name: string, @Query("email") email: string) {
    return this.customers.create(name, email)
  }

  @Get(":id")
  read(@Param("id") id: string) {
    const customer = this.customers.find(id)
    if (customer === undefined) throw new Error(`customer not found: ${id}`)
    return customer
  }

  @Get()
  list() {
    return this.customers.list()
  }
}
