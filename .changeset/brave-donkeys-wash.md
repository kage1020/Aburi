---
"@aburi/core": minor
"@aburi/cli": patch
---

Answer for a malformed Document instead of crashing inside the answer

`checkIRIntegrity` is the only gate a Document read off disk passes through — `readIR`
checks `$schema` and hands the parsed object straight to it — and it assumed the object it
received was already an IR. Six shapes that survived that gate produced a `TypeError`
instead of a violation list:

```
symbols: [{}]           TypeError: symbol.effects is not iterable
symbols: {}             TypeError: ir.symbols is not iterable
missing workspace       TypeError: Cannot read properties of undefined (reading 'managers')
missing stats           TypeError: Cannot read properties of undefined (reading 'callResolution')
missing components      TypeError: ir.components is not iterable
missing dependencies    TypeError: ir.dependencies is not iterable
```

The CLI wrapped each as `config-error`, so a user was told the IR failed to load and not
which invariant broke — which is the one thing the invariant list exists to say.

**Invariant #20** is the precondition made explicit: the Document carries every container
and field the other nineteen read. When it fails it is reported alone, because the other
nineteen read the fields it just called absent and would answer with violations about
`undefined`. It covers the checker's own precondition rather than the schema's `required`
list, so the two cannot drift — a field the checker stops reading leaves #20 in the same
edit — and it names the record and the field:

```
[#20] symbols[0]: "name" is absent, not a string
[#20] workspace: "workspace" is absent, not an object
```

`checkIRIntegrity` and `assertIRIntegrity` now take `unknown`. Every other caller holds a
typed `IR`, but the one these exist for does not, and declaring `IR` had the functions
assert the very thing they were being asked to establish. `readIR` brands its parsed object
*after* the check rather than before, and its own three-array pre-check is gone: #20 covers
it, and a second copy would only be a second place for the answer to drift from the one the
invariant list gives.
