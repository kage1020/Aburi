---
"@aburi/types": minor
"@aburi/lang-typescript": minor
---

`CallCandidate` gains an optional `receiverType`: the named type a call's receiver is declared with, type arguments aside. `@aburi/lang-typescript` sets it for a call through `this.<field>` when the class `this` is bound to declares the field with a named type, as a typed field or a constructor parameter property, so an effect plugin can recognise `this.eventEmitter.emit(…)` beside `constructor(private readonly eventEmitter: EventEmitter2)` by the type rather than by the field's name. A plain name, a field with no annotation and a type that is not a name (a union, an object type) leave it absent. It reaches no IR field and no fingerprint.
