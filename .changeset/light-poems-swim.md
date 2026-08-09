---
"@aburi/diff": patch
---

Pair array-delta elements with their own counterpart, not the first key hit

§5.2 pairs `rules`, `calls` and `decorators` by an identity key with a ±`lineFuzz` tolerance,
so a cosmetic line shift is not reported as a change. A key does not identify one element,
though — a Symbol routinely holds two `guard` rules, two calls to one target, two `@Get` — and
which base element a head element took was decided by base array order.

Deleting the first of two guards two lines apart:

```
base  guard@1 "!user"   guard@3 "!invoice"
head                    guard@3 "!invoice"
```

```json
"rules": {
  "added": [],
  "removed":  [ { "type": "guard", "line": 3, "condition": "!invoice" } ],
  "modified": [ { "type": "guard", "line": 3, "condition": "!invoice" } ]
}
```

The surviving guard claimed `guard@1` — the first key hit inside the window — so an untouched
element was reported as `removed` and `modified` at once, under contradictory buckets, and the
guard actually deleted appeared nowhere. The same shape reproduced for `calls` and
`decorators`.

Pairing now runs in two passes: elements whose key **and content** agree, nearest line first,
then whatever is left, nearest line first. An untouched element is claimed by its own
counterpart before an edited or deleted neighbour can take it, and what remains pairs with what
is nearest — where a genuine edit lands.

Both passes are needed. Nearest-line alone fixes the reported case and breaks two others,
because it pairs by proximity even when an exact counterpart sits a line further away:

| base | head | first key hit | nearest line | two passes |
|---|---|---|---|---|
| `guard@1 "!user"`, `guard@3 "!invoice"` | `guard@3 "!invoice"` | removed **and** modified `!invoice` | removed `!user` | removed `!user` |
| `guard@1 "!a"`, `guard@2 "!b"` | `guard@2 "!a"`, `guard@3 "!b"` | nothing | modified `!a`, modified `!b` | nothing |

The second row is two guards shifted down a line together with nothing edited — the noise line
fuzz exists to suppress, which proximity alone reintroduces. Two guards that swap places now
report nothing, where either single-pass rule reports two edits.

Ties go to the lower base index. An array delta reads array order and cannot be independent of
it the way §3.8's Symbol pairing is — ir-schema §14 #11 fixes these arrays canonically, so
reading the order is reading the Document. What the tie-break buys is that the answer follows
the order the IR states rather than the order the loop enumerates.

`docs/design/diff-algorithm.md` gains §5.2.0, which said nothing about elements sharing a key.
