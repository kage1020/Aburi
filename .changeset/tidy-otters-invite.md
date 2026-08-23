---
"@aburi/core": minor
---

Decide `.gitignore` the way git decides it

`.gitignore` was translated line by line into globs and handed to the file walk's ignore list.
A negation cannot do anything there: a directory the walk skipped never produces the file a
later `!rule` would have put back, so an explicit un-ignore was dropped silently — while the
function's own docstring said negation was preserved.

Measured against real `git check-ignore` over 18 pattern sets, the translation agreed on 13,
and every disagreement lost a file git keeps:

- `assets/*` with `!assets/keep.ts` — the directory itself was never excluded, so git reaches
  the negation and keeps the file
- `*.log` with `!keep.log` — the same shape without a directory
- `src/` followed by `!src/` — a directory put back
- a file literally named `a[1].ts` — brackets are a character class, so the literal name is not
  what the pattern matches
- `*` with `!src/` and `!src/a.ts` — everything excluded, then one directory and one file put
  back

The file is now compiled into a matcher and every discovered candidate is asked about it, and
the glob translation is gone. Git's two rules pull opposite ways — a later `!rule` re-includes,
and nothing re-includes under a directory excluded outright, because git never descends into it
— and both hold now, which is what a pruned walk could not do.

The cost is that a `.gitignore`d directory is walked rather than skipped. What such a file
usually names — `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `.venv` — is in
the core drop list and is still pruned there.

Matching is case-sensitive, against the matcher's own default. Git folds case only where
`core.ignoreCase` says so — false on ext4, true on NTFS and APFS — so no single setting agrees
with git everywhere; folding would drop a file git keeps wherever git is case-sensitive, which
is the direction that loses data and the one the glob translation being replaced already got
right.

Unchanged: `config.ignore` and language-plugin drop patterns are globs by contract and still go
to the walk, so no `.gitignore` negation can rescue a file they exclude. Only the workspace
root's `.gitignore` is read, as before.
