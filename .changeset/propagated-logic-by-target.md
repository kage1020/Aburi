---
"@aburi/core": patch
---

The `logic` fingerprint now reads a Symbol's propagated effects sorted by target. It hashed them in the IR's `(effectId, target)` order, so an effect plugin reclassifying one call (`db.write` → `x-acme:create`, or two effect plugins swapped in the config) could move a target past another one and change the `logic` of every transitive caller, while the callee kept its own; `aburi diff` then reported those callers as changed and tripped `--fail-on changed`. The IR order is unchanged. Callers with two or more propagated effects whose targets were not already in that order get a new `logic` value once, so a diff against an IR written before this release can report them as changed one time.
