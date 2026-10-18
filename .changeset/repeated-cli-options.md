---
"@aburi/cli": minor
---

`aburi diff` kept only the last `--fail-on`, so `--fail-on changed --fail-on removed` gated on `removed` alone and exited 0 over a changed Symbol, with nothing on stderr. Each occurrence now adds its clauses after the earlier ones', exactly as the comma form does: that run exits 3 with `--fail-on changed tripped (observed: 1 changed)`, as `--fail-on changed,removed` does. Each occurrence is read as a value of its own, so `--fail-on bogus --fail-on changed`, which used to gate on `changed` alone, exits 2 with `--fail-on value "bogus" is invalid: unknown token "bogus"`. `runDiff` takes a list of `--fail-on` values as well as one.

Every other option that takes a value kept its last one too and dropped the earlier ones without a word: `--config`, `--output-dir`, `--format`, `--max-bytes`, `--base`, `--head`, `--ir` and the `--output` of `init` and `explain`. A second occurrence now exits 2 before anything is read or written, naming the option and both values: `--config is given more than once ("a.json", then "b.json"): pass one`. `--ignore` still adds up, and a flag without a value, or either half of a `--x` / `--no-x` pair, can still be repeated, the last one written applying. A CI script that repeats `--fail-on` now gates on every clause it names, and can turn red on a change the last clause alone let through; one that repeats any other value option exits 2 until it passes it once.

Only argument handling changes. Nothing a scan or a diff writes is different, so an IR scanned before this release, compared with one scanned after, shows no change the release caused.
