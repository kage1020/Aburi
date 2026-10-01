---
"@aburi/diff": patch
"@aburi/core": patch
---

A deleted function is no longer reported as moved into an unrelated Symbol

Every Symbol with no rules and no effects (a class, an enum, a body that only calls something)
shares one logic fingerprint, and stage 3 paired a lone base in that group with whichever head
was closest by name, with no similarity floor and no kind check. A deleted function and an
unrelated class added anywhere became one `moved+changed`, so `summary.removed` stayed 0 and
`--fail-on removed` passed. Stage 3 now groups by kind as well as logic fingerprint, and the
empty-logic group (`EMPTY_LOGIC_FINGERPRINT`, now exported by `@aburi/core`) has no lone-candidate
shortcut: a pair in it needs a name similarity of 0.85 and a name of more than one word on both
sides. A class that moved file without git rename information still pairs when its name says two
words or more.
