import { Module } from "@nestjs/common"
import { EventEmitterModule } from "@nestjs/event-emitter"
import { AuditRepository } from "./audit/audit.repository"
import { OrdersController } from "./orders/orders.controller"
import { OrdersService } from "./orders/orders.service"
import { PaymentsClient } from "./payments/payments.client"

@Module({
  imports: [EventEmitterModule.forRoot()],
  controllers: [OrdersController],
  providers: [OrdersService, AuditRepository, PaymentsClient],
})
export class AppModule {}
