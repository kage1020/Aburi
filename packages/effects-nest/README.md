# @aburi/effects-nest

NestJS effect plugin for `@aburi/core`. Classifies event-emitter `.emit(...)`
calls into the core `event.publish` effect so the IR captures out-of-process
signalling without conflating it with regular method calls.

Recognised shapes:

| Source shape | Effect |
|---|---|
| `eventBus.emit(...)` | `event.publish` |
| `eventEmitter2.emit(...)` (or any identifier matching `EventEmitter2`) | `event.publish` |

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
