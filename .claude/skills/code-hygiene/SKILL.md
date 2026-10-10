---
name: code-hygiene
description: Audit Aburi for duplicated code, redundant test cases and comments or test titles that cite rotting references (design-doc sections, spec ids, issue numbers). Use when asked to find duplicates, trim tests, review comments, or before a refactor touches many tests.
---

# Code hygiene audit

Three questions, each with a tool. The tools produce leads; every removal is a judgement call you make by
reading both sides.

## 1. Duplicated source

```bash
similarity-ts packages/*/src --threshold 0.85 --min-lines 5            # functions
similarity-ts packages/*/src --types-only --no-functions --threshold 0.85  # types
```

`similarity-ts` (cargo install similarity-ts) is structural: pairs such as a tokenizer and an assignment
loop score high and mean nothing. A real duplicate is the same responsibility written twice — merge it into
the lower package that both depend on, never into a package above either.

## 2. Redundant test cases

```bash
node .claude/skills/code-hygiene/scripts/similar-tests.mjs --threshold 0.9 --min-lines 4 [globs…]
```

`similarity-ts` skips anonymous callbacks, so the script mirrors each `it()`/`test()` body as a named
function first and maps the pairs back to `file:line` and title. Two cases are redundant only when they
drive the same code path to the same assertion; similar shape with different inputs is usually a table —
fold those into `it.each`. Never delete the only test of a branch.

## 3. References that rot

```bash
node .claude/skills/code-hygiene/scripts/references.mjs [globs…]
```

Lists comments and `describe`/`it` titles that cite `§` sections, `*.md` files, spec ids (`CR5`, `LP8q`),
invariant numbers or issues. Rewrite the sentence without the citation, or delete it if nothing is left.
Exits non-zero while any remain.

## The rules these enforce

- Code says how; a comment says only the why the code cannot, briefly; nothing says what. A comment that
  states behaviour is a test that has not been written — write the test and drop the comment.
- Tests pin behaviour. No test reads repository files to check how they are written.
- Shared test helpers live in `@aburi/test-support` (usable everywhere) or `@aburi/test-harness` (real scans
  and diffs; only for packages above core, diff and plugin-registry), not copied between suites.
