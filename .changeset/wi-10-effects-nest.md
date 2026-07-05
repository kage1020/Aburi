---
"@aburi/effects-nest": minor
---

Introduce `@aburi/effects-nest`, the NestJS effects plugin. Recognizes `<...>.<eventBus|EventEmitter2>.emit(...)` call expressions and classifies them into the core `event.publish` effect vocabulary.

### Recognition strategy (two-signal defense)

Both signals must be present before an effect is emitted:

1. The file must import a recognized event-emitter module — `@nestjs/event-emitter` (the NestJS wrapper) or `eventemitter2` (the underlying library). Node's built-in `events` module is intentionally excluded because its per-instance state and stream-oriented `emit` calls do not fit the domain-event vocabulary.
2. The trailing two segments of the target must be `<name>.emit` where `<name>` is one of the two recognized identifiers (`eventBus` — the conventional DI'd name — or `EventEmitter2` — the class itself). The name hint stops arbitrary `.emit(...)` calls on sockets, streams, and user-named helpers from false-classifying even when the file legitimately imports the emitter module.

Leading segments are irrelevant — `eventBus.emit`, `this.eventBus.emit`, and `container.services.eventBus.emit` all classify identically.

### Effect id and derivedBy

- `effectId: "event.publish"` — core-owned vocabulary per extension-vocab.md §5.1, not declared in the manifest.
- `derivedBy: "effects-plugin:nest:<name>.emit"` — plugin-scoped rationale. `EFFECTS_NEST_DERIVED_BY_PREFIX` const is shared between the classifier's tag builder and the manifest's `derivedByPrefixes` entry so drift is impossible.

### Malformed input fail-fast

Empty targets, leading / trailing dots, and adjacent dots are language-plugin contract violations. The classifier throws instead of silently returning null or false-classifying — otherwise `eventBus..emit` would slip through the name gate.

### Manifest

`type: "effects"` with `xPrefix` deriving to `"nest"`. `derivedByPrefixes: ["effects-plugin:nest"]`. Everything else empty (no v0.1 `x-nest:*` bindings, no frameworks or extKinds — those sit in `@aburi/framework-nestjs`).

The plugin does NOT declare `dropCallees`: NestJS's built-in `Logger` from `@nestjs/common` is DI'd per-provider, so a general prefix drop would sweep too widely (per effect-plugin.md §9.2).

### Public API

`nestEffectsPlugin` (ready-to-register instance), `NestEffectsPlugin` (class), `classifyNestCall`, `hasNestEmitterImport`, `effectsNestManifest`, identifier vocabulary (`NEST_EVENT_EMITTER_IDENTIFIERS`, `NEST_EMIT_METHOD`) with `is*` guards, plus types `NestEventEmitterIdentifier`, `NestEmitMethod`.

### Purity

`classify()` is a pure lookup — no I/O, no state, no async — matching the per-call timeout budget the core enforces (effect-plugin.md §5.1.1). Repeated invocations against the same CallCandidate produce identical results.
