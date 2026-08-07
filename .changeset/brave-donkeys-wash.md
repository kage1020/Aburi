---
"@aburi/core": minor
"@aburi/cli": patch
---

Establish the Document's shape before the invariants assume it

`checkIRIntegrity` took an `IR` and dereferenced its way through the Document. `readIR`
brands a parsed JSON object after checking `$schema`, so in practice the checker is the only
gate a Document read off disk passes — and it assumed the thing it was being asked to
establish. Fourteen shapes that survive that gate produced a `TypeError` instead of a
violation list, among them a missing `workspace`, a `stats.callResolution` of `null`, a
non-string entry in `components[].roots`, and a `derivedFrom` of `null`.

The CLI wrapped each as `config-error`, so a user was told the IR failed to load and not
which invariant broke — which is the one thing the invariant list exists to say.

**Invariant #20** is the Document's shape as `aburi.ir.v1` requires it: every `required`
field, of the declared kind, at every depth. It names the record and the field:

```
[#20] symbols[0]: "fingerprint" is absent, not an object
[#20] document: "workspace" is absent, not an object
[#20] components[0].roots[0]: entry is a number, not a string
```

Three decisions worth stating:

- **The scope is the schema's requirements, not "the fields the invariants read".** `readIR`
  brands its result `IR` on the strength of this check, so what #20 establishes is what that
  brand asserts. A narrower check would hand `@aburi/diff` a Document with no `fingerprint`
  and let it fail on `b.fingerprint.logic`, outside anyone's error handling and with no file
  or field named.
- **The restatement is checked, not trusted.** A test reads `schema/aburi.ir.v1.json` and
  fails on a `required` entry with no counterpart in the spec, on a spec field the schema
  does not declare, and on a structural definition the spec omits entirely.
- **#20 is reported alone.** The nineteen relational invariants are statements about a
  Document; a value that fails #20 is not one.

`checkIRIntegrity` and `assertIRIntegrity` now take `unknown`. Every other caller holds a
typed `IR` and is unaffected; the caller these exist for holds a parsed JSON object, and
declaring `IR` had them assert what they were being asked to establish. `readIR` brands
after the check rather than before, and its own array pre-check is gone — #20 covers it, and
a duplicate is only a second place for the answer to drift.

Also fixed by the same shape guarantee: four invariants that a mistyped field silently
disabled rather than crashed. `dropped: "true"` skipped #5 entirely, `derivedFrom: 5` passed
#11 because `(5).length` is `undefined`, and `workspace.languages: [null]` passed #18 because
the grammar regex coerced `null` to the string `"null"`.
