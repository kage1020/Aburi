import { Injectable } from "@nestjs/common"

interface StoredCustomer {
  id: string
  name: string
  email: string
}

@Injectable()
export class CustomersService {
  private readonly customers: StoredCustomer[] = []

  create(name: string, email: string): StoredCustomer {
    if (email.length === 0) throw new Error("customer email must not be empty")
    const customer: StoredCustomer = {
      id: `cus-${this.customers.length + 1}`,
      name,
      email,
    }
    this.customers.push(customer)
    return customer
  }

  find(id: string): StoredCustomer | undefined {
    return this.customers.find((customer) => customer.id === id)
  }

  list(): StoredCustomer[] {
    return [...this.customers]
  }
}
