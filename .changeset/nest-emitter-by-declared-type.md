---
"@aburi/effects-nest": minor
---

`.emit(...)` on a field declared as `EventEmitter2` is now classified as `event.publish`, whatever the field is called. Only the receiver names `eventBus` and `EventEmitter2` were recognised, so the injection NestJS documents, `constructor(private readonly eventEmitter: EventEmitter2)` with `this.eventEmitter.emit("order.created", …)`, stayed a plain call and `aburi diff` reported adding one as a syntax-only change. The type must be the `EventEmitter2` the file imports from `@nestjs/event-emitter` or `eventemitter2`, under its own name, an alias or a namespace; the effect is `high` confidence and tagged `effects-plugin:nest:EventEmitter2.emit`. A `socket.emit(...)` stays a call. An IR scanned before this release reports such a method once as a logic change, its `emit` moving from `calls` to `effects`. This needs `@aburi/lang-typescript` from the same release, which reads the declared type.
