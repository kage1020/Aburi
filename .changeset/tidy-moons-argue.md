---
"@aburi/cli": patch
---

Three-dot ref specs are refused by name instead of half-parsed

`aburi diff main...HEAD` split on every `..`, which made the head ref `.HEAD` — two parts,
both non-empty, so it passed the syntax check. What the reader saw was git failing on a ref
they never typed:

```
Head ref '.HEAD' could not be resolved. If this is a CI shallow clone, run: git fetch --deepen=50 origin .HEAD
```

That is exit 1 (a computation error, someone else's problem to fix) for what `cli-spec.md`
§6.5 classifies as a syntax violation, exit 2. And three-dot is a realistic thing to type: it
is the form in a GitHub compare URL and in `git diff a...b`.

The spec is now split at the first `..` with the whole dot run measured, so the three-dot form
is recognised rather than mangled. It is rejected — `aburi diff` compares the two revisions
directly and has no merge-base form — with the two-dot rewrite and the command that resolves a
merge base spelled out:

```
diff argument "main...HEAD" uses the three-dot form. aburi diff compares the two revisions
directly, so write it as "main..HEAD". To compare the head against the merge base instead,
resolve that yourself: aburi diff "$(git merge-base main HEAD)..HEAD".
```

Refusing beats quietly reading it as `main..HEAD`: the two forms answer different questions, and
a diff against the wrong base is a report the reader has no reason to distrust.

Emptiness is checked before the dot run is judged, so `main...` still reads as a missing head
ref rather than as a three-dot spec whose suggested rewrite would be `main..`. Longer dot runs
and a second separator (`a..b..c`) keep the generic message. Two-dot specs are untouched,
including tags that carry dots of their own — `v1.2.0..v1.3.0` parses as it always did.
