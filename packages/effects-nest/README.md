# @aburi/effects-nest

NestJS effect plugin for `@aburi/core`. Classifies event-emitter `.emit(...)`
calls into the core `event.publish` effect so the IR captures out-of-process
signalling without conflating it with regular method calls.

Recognised shapes:

| Source shape | Effect |
|---|---|
| `eventBus.emit(...)` | `event.publish` |
| `EventEmitter2.emit(...)` | `event.publish` |
| `this.<field>.emit(...)`, the field declared as `EventEmitter2` | `event.publish` |

The receiver is recognised by its name or by its declared type. The name check
is a case-sensitive exact match against a fixed set (currently
`["eventBus", "EventEmitter2"]`) — `eventemitter2.emit(...)` and
`myBus.emit(...)` intentionally fall through so the recognizer is loud and
narrow rather than heuristic. The type check covers the injection NestJS
documents, whatever the field is called:

```ts
constructor(private readonly eventEmitter: EventEmitter2) {}

create(id: string) {
  this.eventEmitter.emit("order.created", { id })
}
```

The type is the one the language plugin reads off the class (a constructor
parameter property or a typed field), and it must be the `EventEmitter2` the
file imports from an emitter module: under its own name, under an alias
(`EventEmitter2 as Bus`), through a namespace (`ee.EventEmitter2`), or as
`eventemitter2`'s default import. Only a field of `this` that the class itself
declares carries a type: a parameter or local
(`publish(bus: EventEmitter2) { bus.emit(…) }`), an inherited field and
`this.hub.bus.emit(…)` go through the name check alone, so `bus.emit(…)` there
stays a call. The name check comes first: `this.eventBus.emit(…)` is a publish
tagged `eventBus.emit` whatever `eventBus` is declared as.

Layered gate: the owning file must import a recognised event-emitter module
(`@nestjs/event-emitter` or `eventemitter2`), the method must be `emit`, and the
receiver must be recognised. `socket.emit(...)` on a file that imports the
emitter module is NOT classified; `eventBus.emit(...)` on a file that never
imports it is NOT classified. Both signals required.

## Install

```bash
pnpm add @aburi/effects-nest
```

## Usage

```ts
import { nestEffectsPlugin } from "@aburi/effects-nest"
```

## See also

- [`docs/design/effect-plugin.md`](../../docs/design/effect-plugin.md)
