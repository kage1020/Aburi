# What is Aburi?

Aburi is a command-line tool that reads your source code and tells you what a
change did.

Run it on a pull request and you get a Markdown summary: this endpoint is new,
this method now writes to the database, this validation guard disappeared, these
files only moved. Your CI can fail the build on any of it.

## The problem with `git diff`

Open a 2,000-line diff and you have to reconstruct the intent from the text.
Two things get in your way.

**The noise outweighs the signal.** A formatting pass, a rename, or a file move
fills the diff with changes that carry no meaning, and you read them anyway.

**The signal looks like the noise.** A single added `if` that skips a permission
check looks the same as a single added `if` that fixes a typo.

Aburi separates the two. It parses both revisions, matches functions and methods
across them, then compares what they *do*: their signature, their control flow,
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

That deleted guard is a single red line somewhere in the raw diff. Aburi gives
it a heading.

[Reading the report](./reading-the-report.md) walks through every section.

## What makes it usable in CI

**It is deterministic.** No model, no sampling. The same commit produces the
same bytes, so you can compare two reports to each other and trust the
difference.

**It survives refactoring.** Rename a file without touching its logic and you
get `moved`, where a line-based diff gives you a delete plus an add.

**It ignores boilerplate.** Interfaces, DTOs, re-exports, and empty bodies drop
out before the comparison, so they stay out of your summary.

**You can gate on any of it.** Pick a category the report counts and give it a
threshold: `--fail-on 'removed,changed:>20'`.

## What it will not do for you

Aburi describes a change. You decide what to do about it. It holds no opinion
on your style, suggests no fixes, and calls no LLM, so the judgement stays with
you or with whatever tool you feed the report to.

Linting belongs to Biome and ESLint. Aburi stays out of their way.

## Where to go next

- [Getting started](./getting-started.md) walks you from install to your
  first diff.
- [Supported stacks](./supported-stacks.md) tells you whether your framework
  is covered.
- [CI integration](./ci-integration.md) posts the report on every pull
  request.
