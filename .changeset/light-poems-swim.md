---
"@aburi/diff": minor
---

Pair array-delta elements with their own counterpart, not the first key hit

§5.2 pairs `rules`, `calls`, `decorators` and `effects` by an identity key — the first three
with a ±`lineFuzz` tolerance on the line, `effects` with none at all — so a cosmetic line shift
is not reported as a change. A key does not identify one element,
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

Pairing now runs in two passes — elements whose key **and content** agree, then whatever is
left — and each pass chooses a *set* of pairings rather than one at a time: the largest set
that does not cross, and among those the one moving the fewest lines. An untouched element is
claimed by its own counterpart before an edited or deleted neighbour can take it, and what
remains pairs by proximity, where a genuine edit lands.

Every part earns its place:

| base | head | first key hit | nearest line, greedy | this rule |
|---|---|---|---|---|
| `guard@1 "!user"`, `guard@3 "!invoice"` | `guard@3 "!invoice"` | removed **and** modified `!invoice` | removed `!user` | removed `!user` |
| `guard@1 "!a"`, `guard@2 "!b"` | `guard@2 "!a"`, `guard@3 "!b"` | nothing | modified `!a`, modified `!b` | nothing |
| `guard@1 "!a"`, `guard@2 "!a"` | `guard@3 "!a"`, `guard@4 "!a"` | nothing | added `!a`, removed `!a` | nothing |

Row 2 is two guards shifted down a line with nothing edited — the noise line fuzz exists to
suppress, which proximity alone reintroduces. Row 3 is the same shift where the guards are also
identical, so the exact pass cannot separate them either: greedily the first head element is
nearest the *second* base element, and claiming it strands the other outside the window. Two
calls to one target and two copies of one decorator are the ordinary way that arises.

Non-crossing is licensed by ir-schema §14 #11, which orders these arrays by line: two pairings
that crossed would have an element move above one it was below, which is a different element
rather than a shift. It also settles ties, and makes the best set reachable by a suffix
recurrence rather than a general assignment.

The result depends on array order and cannot not — it pairs by line, and #11 is what fixes that
order. §3.8 achieves order-independence for Symbol pairing because ids give it a total order
from content; §5.2 has no counterpart, and §3.7 records the distinction.

**`effects` are affected too.** They pass no line window, so every same-key candidate is
admissible and only the ranking applies — but the ranking reads `line`, and a propagated entry
has none. The `line ?? 0` placeholder now reads as "at the top of the Symbol" rather than as a
neutral value, so a propagated effect prefers the earliest local entry carrying its key. Two
entries of one key that swapped places now report nothing, where before they reported two
modifications.

`docs/design/diff-algorithm.md` gains §5.2.0, which said nothing about elements sharing a key.
