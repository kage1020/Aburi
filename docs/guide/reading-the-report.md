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
| `changed` | Same symbol, different behaviour. |
| `moved` | Same behaviour, different file or name. |
| `moved+changed` | Both. |
| `unknown` | Aburi could not read one side. See [Gaps](#gaps-in-the-report). |

`?N unknown` shows up when that count is non-zero. When you see it, read the
added and removed counts beside it as lower bounds.

## The sections

Sections appear in a fixed order, most important first. Aburi drops the empty
ones and folds the last three behind a `<details>`.

| Section | What it tells you | Your next move |
|---|---|---|
| ⚠ API changes | A public surface moved: signature, throws, or decorators. | Check every caller. |
| 🔧 Logic changes | Control flow or effects changed inside a body. | This is the review. |
| ➕ Added | New symbols, rendered in full. | Read the effects and rules. |
| ➖ Removed | Symbols that disappeared. | Confirm you meant to delete them. |
| ❔ Unknown | One revision never analysed the file. | Fix the scan, not the code. |
| 🚫 Not compared | Neither revision analysed the file. | A standing blind spot. |
| 🔀 Moved + Changed | Relocated and modified. | Read it like a Logic change. |
| 🔀 Moved | Relocated, behaviour identical. | Skim and move on. |
| 🧱 Component changes | A component appeared, vanished, or changed roots. | Architectural. Worth a look. |
| 🔗 Dependency changes | A new or dropped edge between components or symbols. | Watch for layering violations. |
| 💧 Dropped changes | Boilerplate that came or went. | Usually nothing. |
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

A change entry lists what differs. For an added or removed symbol, Aburi
renders the whole thing:

```md
### `refundOrder` *(function)*
**File**: `src/app/orders/actions.ts:64`
**Boundary**: `"use server"`
**Effects**:
- db.write: `prisma.order.update` (L72)
**Rules**:
- guard: `!order.canRefund` (L67)
- throw: `new RefundNotAllowed()` (L68)
```

Three field groups carry most of the meaning.

**Boundary** names what makes the symbol reachable from outside: an HTTP route,
a message handler, a server action, an exported entry point.

**Rules** are the control flow Aburi kept. Guards, throws, returns, loops,
branches. A removed `guard` line means somebody removed a condition.

**Effects** are what the symbol does to the world: `db.read`, `db.write`,
`db.transaction`, `event.publish`, `network.rpc`. A method that gained
`db.write` now writes to your database.

## Confidence

Aburi flags anything it is less sure about.

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

A `parse-timeout` clears on a re-run most of the time. For the rest, fix the
file or leave it out with [`ignore`](/guide/configuration#exclude-files).

**🚫 Not compared** means neither revision could read the file, so nothing in
the report says anything about it. This is often a standing property of the
repository, such as a generated bundle over the size limit or a language with no
plugin installed, and it will keep showing up until you change the cause.

## The other reports

`aburi scan` writes two more documents, useful outside pull request review.

**`out/workspace.md`** covers the repository at a glance: components and their
roots, the dependency graph between them, the most common effects, and any files
the scan could not read. Hand this one to a new joiner.

**`out/components/<id>.md`** covers one component in full. Every kept symbol,
grouped by file, with its boundaries, signature, rules, effects, and calls.

```md
#### `submitOrder` *(function)*
**Boundary**: `"use server"`
**Signature**: `(cart: Cart) → Promise<Order>` throws `PaymentDeclined` ⚡async
**Rules**:
- guard: `cart.items.length === 0` (L21)
- throw: `new EmptyCart()` (L22)
**Effects**:
- db.write: `prisma.order.create` (L34)
```

To look at one symbol, skip the file and ask for it:

```bash
aburi explain submitOrder
```
