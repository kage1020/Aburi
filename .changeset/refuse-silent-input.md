---
"@aburi/config": minor
"@aburi/cli": minor
---

A config key named twice, contradictory `scan` format flags, and an empty `--fail-on` clause are refused

Existing configs and CI arguments that relied on any of these now exit 2. Each was settled rather
than reported. `{ "ignore": ["a/**"], "ignore": ["b/**"] }` kept the second list and dropped
`a/**`; it is now `config-invalid`, naming the key, the object and the line of the second, and so
is a `__proto__` key, which the schema could not see. `aburi scan --no-md --no-json` wrote the IR
anyway, and `--format md --no-md` wrote JSON. A combination that drops everything, or drops an
output `--format` includes, now exits 2 and writes nothing. `--fail-on 'added,'` and
`'added,,removed'` skipped the empty clause; they now exit 2 like an empty value does. A
`--fail-on` error names the whole value as typed and which clause failed.
