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
(`EventEmitter2 as Bus`), or through a namespace (`ee.EventEmitter2`). A plain
parameter (`publish(bus: EventEmitter2)`) is recognised by name only.

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
