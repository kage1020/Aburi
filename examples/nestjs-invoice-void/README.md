# A NestJS controller gains an endpoint

An invoices module in NestJS. The change adds `POST /invoices/:id/void`, which marks an invoice void and
emits an event, makes `create` take a due date, and injects an event emitter into the service.

The report lists the new handler with the `@Post(":id/void")` route it serves and the new service method
with the database write it performs. It flags the widened `create` signatures and the extra constructor
parameter as API changes, and keeps the classes' own reshuffling out of the way as syntax-only.
