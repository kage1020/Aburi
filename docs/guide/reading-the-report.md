# Reading the report

`aburi diff` writes `out/diff.md`. This page walks you through it, from the top
line down.

## The summary line

```md
**Summary**: +5 added · -3 removed · ~12 changed · 2 moved · 1 moved+changed · ?2 unknown
```

A symbol is a function, method, or class that survived boilerplate removal.
Each one lands in a single bucket:

| Bucket | Meaning |
|---|---|
| `added` | Did not exist in the base revision. |
| `removed` | Existed in the base revision and is gone. |
| `changed` | Same symbol, different behaviour, or Aburi grew more or less sure of it. |
| `moved` | Same behaviour, different file or name. |
| `moved+changed` | Both. |
| `unknown` | Aburi could not read one side. See [Gaps](#gaps-in-the-report). |

`?N unknown` shows up when that count is non-zero. When you see it, read the
added and removed counts beside it as lower bounds.

## The sections

Sections appear in a fixed order, most important first. Aburi drops the empty
ones and folds Moved, Dropped changes and Syntax-only changes behind a `<details>`.

| Section | What it tells you | Your next move |
|---|---|---|
| ⚠ API changes | A public surface moved: signature, throws, or decorators. | Check every caller. |
| 🔧 Logic changes | Control flow or effects changed inside a body. | This is the review. |
| 🧵 Slice View | The changed symbols that call one another, grouped into one slice per call chain. | Read a feature end to end. |
| ➕ Added | New symbols, rendered in full. | Read the effects and rules. |
| ➖ Removed | Symbols that disappeared. | Confirm you meant to delete them. |
| ❔ Unknown | One revision never analysed the file. | Fix the scan, not the code. |
| 🚫 Not compared | Neither revision analysed the file. | A standing blind spot. |
| 🔀 Moved + Changed | Relocated and modified. | Read it like a Logic change. |
| 🔀 Moved | Relocated, behaviour identical. | Skim and move on. |
| 🧱 Component changes | A component appeared, vanished, or changed — roots, public API, frameworks, name, languages, or description. | Architectural. Worth a look. |
| 🔗 Dependency changes | A call between two symbols that appeared or went. | Watch for layering violations. |
| 💧 Dropped changes | Boilerplate that came or went. | Usually nothing. |
| 🎚 Confidence changes | Aburi is more or less sure of a symbol, and nothing it fingerprints changed. | Check the new badge (see [Confidence](#confidence)). |
| 🎨 Syntax-only changes | Bodies reformatted, behaviour identical. | Nothing. |

Learn the split between **API changes** and **Logic changes** first. An API
change breaks other people's code. A logic change alters what your own code
does.

## An entry

```md
### `submitOrder` *(function)*
**File**: `src/app/orders/actions.ts:18`

- signature.outputs: `Promise<Order>` → `Promise<OrderWithReceipt>`
- signature.throws added: `PaymentDeclined`
```

A change entry lists what differs. A rule, effect, call or decorator that was
edited rather than added or removed sits under `modified`, with the old value
beside the new one:

```md
- rules modified:
  - loop (`for` → `while`) (L3)
- effects modified:
  - db.write: `prisma.user.create` (L5) [effects-prisma] ⚠ medium (was high)
```

When several elements of one kind were edited at once, such as two guards, and
their old values differ, that field shows only the new value.

A single value that changed reads the same way, old value first:

```md
- signature.typeParameters: none → `<T extends Order>`
- component: `orders` → `checkout`
- visibility: `internal` → `public`
```

For an added or removed symbol, Aburi renders the whole thing:

```md
### `refundOrder` *(function)*
**File**: `src/app/orders/actions.ts:64`
**Rules**:
- guard: `!order.canRefund` (L67)
- throw: `RefundNotAllowed` (L68)

**Effects**:
- db.write: `prisma.order.update` (L72) [effects-prisma]
```

Three field groups carry most of the meaning.

**Boundary** lists the decorators that make the symbol reachable from outside:
NestJS's `@Post()` or `@MessagePattern()`, or one a
[`frameworkHints`](./configuration.md#teach-it-your-in-house-framework) rule marks
with `boundary: true`. A framework without decorators, such as Next.js, records
its route handlers under Derived by instead, which `aburi explain` shows, and the
entry has no Boundary line.

**Rules** are the control flow Aburi kept. Guards, throws, returns, loops,
branches. A removed `guard` line means somebody removed a condition.

**Effects** are what the symbol does to the world: `db.read`, `db.write`,
`db.transaction`, `event.publish`, `network.rpc`. A method that gained
`db.write` now writes to your database.

## A slice

The Slice View groups the changed symbols that call one another, so a feature
reads end to end. Each member says in a line what happened to it:

```md
### `slice:ts:src/app/orders/actions.ts#submitOrder` (2 members)

- `submitOrder` — *(changed)*
  **File**: `src/app/orders/actions.ts:18`
  ↳ API and logic changed
- `chargeCard` — *(added)*
  **File**: `src/lib/payments.ts:7`
  ↳ new function with network.http
```

The symbols that call no other changed symbol are folded under **Standalone
changes**, one line each.

Two slices that should be one can come apart when Aburi could not tell what a
call reaches. When an unresolved call is named like a changed symbol in another
slice, the member says so, and a note under the heading counts them:

```md
  ↳ logic changed · ⚠ unresolved call to `getRepo.save`
```

Read the slice that holds `Repo.save` together with this one. Calls into
libraries or built-ins are never marked: they could not have joined two slices.

## Confidence

Aburi flags anything it is less sure about. A symbol carries the badge on its
heading; an effect, at the end of its row. When the badge on a symbol moves, the
entry says so with a `confidence: before → after` line; when an effect's moves,
its row under `effects modified` ends with the old one, `(was high)`.

| Marker | Meaning |
|---|---|
| *(no badge)* | Confident. |
| `⚠ medium` | The signal matched through an indirection, such as a re-exported decorator or an aliased import. |
| `⚠ low` | A weak match. Verify before you rely on it. |

## Gaps in the report

Two sections tell you what the report could not cover. Both point at the scan
rather than the code.

**❔ Unknown** means one revision analysed the file and the other did not, so a
symbol appears or disappears for reasons unrelated to your change. The entry
names the file and the cause:

```md
### `handleRequest` *(function)*
**File**: `src/app/api/legacy/route.ts:12`
**Why**: the head scan skipped `src/app/api/legacy/route.ts` (parse-failed), so this Symbol may still exist
```

If git renamed the file between the two revisions, the entry reads
`this file under its head name` (or `base name`) followed by the path the
skipping scan used, because that is the file to fix.

A `parse-timeout` clears on a re-run most of the time. For the rest, fix the
file or leave it out with [`ignore`](./configuration.md#exclude-files).

**🚫 Not compared** means neither revision could read the file, so nothing in
the report says anything about it. This is often a standing property of the
repository, such as a generated bundle over the size limit or a language with no
plugin installed, and it will keep showing up until you change the cause.

## The other reports

`aburi scan` writes two more documents, useful outside pull request review.

**`out/workspace.md`** covers the repository at a glance: components and their
roots, the most common effects, and any files the scan could not read. Hand this
one to a new joiner. Its Component dependencies graph shows the components alone
for now: the scan records calls between symbols, which each component page lists,
and no edges between components yet.

**`out/components/<id>.md`** covers one component in full. Every kept symbol,
grouped by file, with its boundaries, signature, rules, effects, and calls.

```md
#### `submitOrder` *(function)*
**Signature**: `(cart: Cart) → Promise<Order>` throws `EmptyCart` ⚡async
**Rules**:
- guard: `cart.items.length === 0` (L21)
- throw: `EmptyCart` (L22)

**Effects**:
- db.write: `prisma.order.create` (L34) [effects-prisma]
```

To look at one symbol, skip the file and ask for it:

```bash
aburi explain submitOrder
```
