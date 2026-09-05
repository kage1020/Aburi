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
resolve it yourself with: git merge-base <base> <head>.
```

Refusing beats quietly reading it as `main..HEAD`: the two forms answer different questions, and
a diff against the wrong base is a report the reader has no reason to distrust. The `git
merge-base` is named with placeholders rather than as a command with the caller's refs pasted
in: `$ ( ) " ; & |` and backticks all pass `git check-ref-format`, so a copy-pasteable command
built from a ref name would hand the reader a shell substitution to run.

The three checks are ordered by what each can still say truthfully. Emptiness first, so `main...`
reads as a missing head ref rather than as a three-dot spec whose suggested rewrite would be
`main..`. A second separator next, so `a..b..c` and `a...b..c` alike keep the generic message —
judged the other way round, the second would be answered with the rewrite `a..b..c`, which this
same function rejects, and with `b..c` named as a ref, which is the defect this change removes.
The dot run last, where a rewrite naming two refs is finally something that parses; a longer run
(`main....HEAD`) has no such rewrite to guess at and keeps the generic message too.

Two-dot specs are untouched, including tags that carry dots of their own — `v1.2.0..v1.3.0`
parses as it always did.
