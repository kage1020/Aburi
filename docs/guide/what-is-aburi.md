# What is Aburi?

Aburi is a command-line tool that reads your source code and reports **what a
change did**, not which lines moved.

Run it on a pull request and you get a Markdown summary: this endpoint is new,
this method now writes to the database, this validation guard disappeared, these
files just moved. CI can fail the build on any of those.

## The problem with `git diff`

A reviewer opening a 2,000-line diff has to reconstruct the intent from the
text. Two things make that hard:

- **Noise wins.** A formatting pass, a rename, or a file move fills the diff
  with changes that mean nothing.
- **Meaning hides.** A single added `if` that skips a permission check looks
  exactly like a single added `if` that fixes a typo.

Aburi separates the two. It parses each revision, matches functions and methods
across them, and compares what they *do* — their signature, their control flow,
the effects they perform.

## What the report looks like

```md
# Aburi diff: main..HEAD

**Summary**: +2 added · -1 removed · ~3 changed · 1 moved

## ⚠ API changes

### `submitOrder` *(function)*
**File**: `src/app/orders/actions.ts:18`

- signature.outputs: `Promise<Order>` → `Promise<OrderWithReceipt>`
- signature.throws added: `PaymentDeclined`

## 🔧 Logic changes

### `POST` *(function)*
**File**: `src/app/api/orders/route.ts:9`

- rules removed:
  - guard: `session.user.role !== 'admin'` (L14)
- effects added:
  - db.write: `prisma.auditLog.create` (L31)
```

The removed guard is one line in `git diff`. Here it is a heading.

[Reading the report](/guide/reading-the-report) walks through every section.

## What makes it usable in CI

- **Deterministic.** No model, no sampling. The same commit produces the same
  bytes, so two reports can be compared to each other.
- **Refactor-tolerant.** A file rename with unchanged logic is reported as
  `moved`, not as a delete plus an add.
- **Boilerplate-free.** Interfaces, DTOs, re-exports, and empty bodies are
  dropped before the comparison, so they never pad the summary.
- **Gateable.** Every category the report shows can be turned into a threshold:
  `--fail-on 'removed,changed:>20'`.

## What it is not

Aburi does not judge your code. It has no opinion on style, it does not suggest
fixes, and it does not call an LLM. It produces a factual description of a
change — reading it, and deciding what to do, stays with you (or with whatever
tool you feed the report to).

It is also not a linter. Biome and ESLint already own that.

## Where to go next

- [Getting started](/guide/getting-started) — install and run your first diff.
- [Supported stacks](/guide/supported-stacks) — check whether your framework is
  covered.
- [CI integration](/guide/ci-integration) — post the report on every pull request.
