---
"@aburi/plugin-registry": patch
---

Refuse a manifest whose own prefixes nest

`VocabRegistry.register` compared a manifest's prefixes only with those of plugins already
registered, never with each other. A manifest declaring `extKindPrefixes: ["fp:pipe",
"fp:pipe:async"]` therefore registered, and the first `findExtKind` under both threw an internal
invariant violation that named the same plugin twice and blamed `register()` for a check it did not
make. `register` now refuses such a manifest with `prefix-prefix-overlap`, naming both prefixes and
the plugin; nesting `derivedByPrefixes` such as `["acme", "acme:route"]` are refused with
`derivedby-prefix-overlap`. Each list is compared with itself, so the same string in `extKindPrefixes`
and `derivedByPrefixes`, as every framework plugin writes it, still registers. A prefix written twice
in one list is refused earlier, by the schema's `uniqueItems`; `register` itself leaves an exact
repeat alone, since it cannot give a lookup two owners.
