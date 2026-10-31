---
"@aburi/types": minor
"@aburi/lang-typescript": minor
"@aburi/core": patch
---

`CallCandidate` gains an optional `receiverType`: the named type a call's receiver is declared with, type arguments aside. `@aburi/lang-typescript` sets it for a call through `this.<field>` when the class `this` is bound to declares the field with a named type, as a typed field or a constructor parameter property, so an effect plugin can recognise `this.eventEmitter.emit(…)` beside `constructor(private readonly eventEmitter: EventEmitter2)` by the type rather than by the field's name. A plain name, a field with no annotation and a type that is not a name (a union, an object type) leave it absent. It reaches no IR field, and the field itself moves no fingerprint; a plugin that classifies by it moves `logic` as any new effect does. `@aburi/core` puts it in NFC with the target before any effect plugin sees it, as it does the import edges, so a type compares equal to the name an import binds whichever spelling either was written in.
