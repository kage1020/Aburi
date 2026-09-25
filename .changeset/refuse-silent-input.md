---
"@aburi/config": patch
"@aburi/cli": patch
---

A config key named twice, contradictory `scan` format flags, and an empty `--fail-on` clause are refused

Each was settled rather than reported. `{ "ignore": ["a/**"], "ignore": ["b/**"] }` kept the
second list and dropped `a/**`; it is now `config-invalid`, naming the key, the object and the line
of the second. `aburi scan --no-md --no-json` wrote the IR anyway and `--format md --no-md` wrote
JSON; a combination that drops everything, or drops what `--format` named, now exits 2 and writes
nothing. `--fail-on 'added,'` and `'added,,removed'` skipped the empty clause; they now exit 2 like
an empty value does.
