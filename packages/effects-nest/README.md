# @aburi/effects-nest

NestJS effect plugin for `@aburi/core`. Classifies event-emitter `.emit(...)`
calls into the core `event.publish` effect so the IR captures out-of-process
signalling without conflating it with regular method calls.

Recognised shapes:

| Source shape | Effect |
|---|---|
| `eventBus.emit(...)` | `event.publish` |
| `EventEmitter2.emit(...)` | `event.publish` |

The identifier check is a case-sensitive exact match against a fixed set
(currently `["eventBus", "EventEmitter2"]`) — `eventemitter2.emit(...)` and
`myBus.emit(...)` intentionally fall through so the recognizer is loud and
narrow rather than heuristic.

Layered gate: the owning file must import a recognised event-emitter module
(`@nestjs/event-emitter` or similar), and the trailing two target segments must
be `<recognised-identifier>.emit`. `socket.emit(...)` on a file that imports the
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

- [`design/details/effect-plugin.md`](../../design/details/effect-plugin.md)
