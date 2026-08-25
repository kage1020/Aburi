# Reading the report

`aburi diff` writes `out/diff.md`. This page explains how to read it, from the
top line down.

## The summary line

```md
**Summary**: +5 added · -3 removed · ~12 changed · 2 moved · 1 moved+changed · ?2 unknown
```

Each symbol — a function, method, or class that survived boilerplate removal —
falls into exactly one bucket:

| Bucket | Meaning |
|---|---|
| `added` | Did not exist in the base revision. |
| `removed` | Existed in the base revision and is gone. |
| `changed` | Same symbol, different behaviour. |
| `moved` | Same behaviour, different file or name. |
| `moved+changed` | Both. |
| `unknown` | Aburi could not read one side. See [Gaps](#gaps-in-the-report). |

`?N unknown` only appears when it is non-zero. When it does, treat the added
and removed counts beside it as lower bounds.

## The sections

Sections appear in a fixed order, most important first. Empty ones are omitted,
and the last three are collapsed behind a `<details>` fold.

| Section | What it tells you | Typical response |
|---|---|---|
| ⚠ API changes | A public surface moved: signature, throws, or decorators. | Check every caller. |
| 🔧 Logic changes | Control flow or effects changed inside a body. | This is the review. |
| ➕ Added | New symbols, rendered in full. | Read the effects and rules. |
| ➖ Removed | Symbols that disappeared. | Confirm the deletion was intended. |
| ❔ Unknown | One revision never analysed the file. | Fix the scan, not the code. |
| 🚫 Not compared | Neither revision analysed the file. | A standing blind spot. |
| 🔀 Moved + Changed | Relocated *and* modified. | Read it like a Logic change. |
| 🔀 Moved | Relocated, behaviour identical. | Skim and move on. |
| 🧱 Component changes | A component appeared, vanished, or changed roots. | Architectural — worth a look. |
| 🔗 Dependency changes | A new or dropped edge between components or symbols. | Watch for layering violations. |
| 💧 Dropped changes | Boilerplate that came or went. | Usually nothing. |
| 🎨 Syntax-only changes | Bodies reformatted, behaviour identical. | Nothing. |

The split between **API changes** and **Logic changes** is the one worth
internalising: the first breaks other people's code, the second changes what
your code does.

## An entry

```md
### `InvoiceService.createInvoice` *(method)*
**File**: `apps/billing/src/InvoiceService.ts:42`

- signature.outputs: `Promise<Invoice>` → `Promise<InvoiceWithReceipt>`
- signature.throws added: `NotFoundError`
- decorator added: `@UseGuards(AuthGuard)`
```

Change entries list only what differs. Added and removed symbols are rendered in
full instead:

```md
### `InvoiceService.refundInvoice` *(method)*
**File**: `apps/billing/src/InvoiceService.ts:101`
**Boundary**: `@Post('/refund')`
**Effects**:
- db.write: `prisma.invoice.update` (L120)
**Rules**:
- guard: `!invoice.canRefund` (L110)
- throw: `new RefundNotAllowed()` (L111)
```

Three field groups carry most of the meaning:

- **Boundary** — decorators that make this symbol reachable from outside: an
  HTTP route, a message handler, an exported entry point.
- **Rules** — the control flow that was kept: guards, throws, returns, loops,
  branches. A removed `guard` line is a removed condition.
- **Effects** — what the symbol does to the world: `db.read`, `db.write`,
  `db.transaction`, `event.publish`, `network.rpc`, and so on. A method that
  gained `db.write` now writes to your database.

## Confidence

Aburi marks anything it is less sure about:

- No badge — confident.
- `⚠ medium` — the signal matched, but through an indirection (a re-exported
  decorator, an aliased import).
- `⚠ low` — a weak match. Verify before relying on it.

## Gaps in the report

Two sections describe what the report does **not** cover. They are not review
items; they are scan problems.

**❔ Unknown** — one revision analysed the file and the other did not, so a
symbol appears or disappears for reasons that have nothing to do with the
change. The entry names the file and why:

```md
### `handleRequest` *(function)*
**File**: `apps/web/src/route.ts:12`
**Why**: the head scan skipped `apps/web/src/route.ts` (parse-failed), so this Symbol may still exist
```

A `parse-timeout` usually clears on a re-run. The rest need the file fixed, or
excluded via [`ignore`](/guide/configuration#exclude-files).

**🚫 Not compared** — neither revision could read the file, so nothing in the
report says anything about it. Usually a permanent property of the repository —
a generated bundle over the size limit, a language with no plugin installed —
and it will keep appearing until you change the cause.

## The other reports

`aburi scan` writes two more documents, useful outside pull-request review.

**`out/workspace.md`** is the repository at a glance: components and their
roots, the dependency graph between them, the most common effects, and any
files the scan could not read. This is the page to hand a new joiner.

**`out/components/<id>.md`** is one component in full — every kept symbol
grouped by file, with its boundaries, signature, rules, effects, and calls.

```md
#### `InvoiceService.createInvoice` *(method)*
**Boundary**: `@Post('/invoices')` `@UseGuards(AuthGuard)`
**Signature**: `(customerId: CustomerId, items: LineItem[]) → Promise<Invoice>` throws `CreditLimitExceeded` ⚡async
**Rules**:
- guard: `customer.creditLimit < invoice.total` (L58)
- throw: `new CreditLimitExceeded(customer.id, invoice.total)` (L60)
**Effects**:
- db.write: `prisma.invoice.create` (L75)
```

For a single symbol, skip the file and ask directly:

```bash
aburi explain InvoiceService.createInvoice
```
