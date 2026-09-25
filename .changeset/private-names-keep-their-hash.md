---
"@aburi/core": minor
"@aburi/lang-typescript": minor
---

A `#`-private member keeps its `#` in its qualified name

`v() {}` beside `#v() {}` produced one Symbol, `Q.v`, carrying both bodies and the visibility of
whichever was written first. A qualified-name segment may now open with `#`, and the private
member is `Q.#v`. Ids of every `#`-private member change from `Q.v` to `Q.#v`. A quoted `"#v"`
is still the public property with those characters and still has no Symbol.
