---
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

A `#`-private member keeps its `#` in its qualified name

`v() {}` beside `#v() {}` produced one Symbol, `Q.v`, carrying both bodies and the visibility of
whichever was written first. A qualified-name segment after a separator may now open with one
`#`, and the private member is `Q.#v` (`Q::#v` when static). What changes for existing IR:

- Ids and `Symbol.name` of every `#`-private member change from `Q.v` to `Q.#v`, and the api
  fingerprint's `shortName` from `v` to `#v`. Comparing IR built before this change with IR built
  after it reports those members as changed.
- The LSP tier now resolves a call such as `this.#v()`: tsserver's hover names `C.#v`, which is
  now a Symbol, so the call gets an edge where it used to count as `memberNotFound`. Private
  members also get columns from document symbols.
- A qualified name may not open with `#`, and `isQnameSegment` admits `#v` only when called with
  `{ privateName: true }`. A quoted `"#v"() {}` and an index `obj["#v"]` are still the public
  property with those characters: the first has no Symbol, the second a `<computed>` segment.
