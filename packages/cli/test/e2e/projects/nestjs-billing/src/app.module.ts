import { Module } from "@nestjs/common"
import { BillingModule } from "./billing/billing.module"
import { CustomersModule } from "./customers/customers.module"
import { LoggerService } from "./common/logger.service"

@Module({
  imports: [BillingModule, CustomersModule],
  providers: [LoggerService],
  exports: [LoggerService],
})
export class AppModule {}
