---
"@aburi/plugin-registry": patch
---

A manifest that declares one effect id or extKind twice is refused, and an unknown `type` is always `manifest-invalid`

The registry compared a manifest only with the plugins already registered, so an id declared twice
in one manifest kept whichever came last. A hand-built manifest whose `type` names something on
`Object.prototype` (`toString`, `constructor`, `__proto__`) was read with the prototype's value as
its rules: with extKinds it failed with an uncoded `TypeError`, with effects it failed with the
wrong code (`namespace-type-mismatch`), and with nothing declared it registered. All of these now
raise the coded errors the other cases already do (`duplicate-id`, `manifest-invalid`), and so does
a `provides` whose arrays are inherited rather than its own.
