---
"@aburi/diff": patch
"@aburi/markdown-projection": patch
---

A component that is renamed, given a language, or given a description is a component that changed

`diffComponents` decided a Component had changed by asking the three questions its `delta`
answers — roots, publicApi, frameworks. A Component carries three more fields. Rename one, add a
language to it, write it a description, and the diff said `componentsChanged: 0` with an empty
`changed[]`: not a quiet entry a reader could miss, but no entry at all, so the Markdown layer
did not even have the before/after pair it would have rendered from.

Two questions had been answered with one list. Whether a Component is `changed` is now decided
over the whole record — every field the document carries, compared canonically, so a field added
to `v1` later counts without this decision being revisited. Which fields the `delta` summarises
is unchanged: the same three booleans, naming the axes a reviewer scans for architectural
movement. A `changed[]` entry whose three booleans are all `false` is the well-formed shape of
"something else about this component moved", and it needs no schema change, because `before` and
`after` were always there.

Two spellings of "no value" are reduced to one before the comparison, scoped to the fields that
license it rather than to a class: a `description` that is `null` compares equal to an absent key
(Class A, where `ir-schema.md` §1.1 requires a reader to treat the two alike), and a `publicApi`
or `frameworks` that is `[]` compares equal to an absent key (those two fields' own writer rule
is "omitted when empty"). Class B does not say that in general — §1.1 is explicit that "absent"
and "empty" are different facts there — so a future Class B field whose presence is itself
information has to be added deliberately. Key order and Unicode form do not make a change either:
the comparison is the canonical serializer the fingerprints are built on, not a second answer to
the same question. A Component it cannot compare — only a hand-assembled one reaches that —
raises `DiffError("ir-shape-invalid")` naming the component and the side, rather than a
`CoreError` leaving the package by a different door on a different exit code. Two things widen
with it: the serializer now sees every matched pair rather than only the components that reach
`changed[]`, and a `--format md` run no longer skips it.

The 🧱 Component changes section reads the fields it lists off `before` / `after` rather than off
`delta`, which is the same conflation on the reviewer-facing side. Those all-`false` entries
exist for the first time with this fix, and a renderer reading only the booleans would draw one
as a row whose colon is followed by nothing — so both halves had to move together. A rename and a
description carry their before → after inline, since for a scalar that is the whole change; the
list-valued fields name themselves as they always have.

Both scalars are free-form text out of the config file and the row reaches a pull request comment
body, so they now render through a code span no value can break out of: newlines collapse to a
space, and the fence widens past the longest backtick run inside the value. An absent description
reads `none` and a present but empty one reads `(empty)`, which are different answers from the
config author. A component whose only difference is in a field this version of the projection has
no rendering for is named on its own rather than dropped.
