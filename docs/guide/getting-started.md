# Getting started

Five minutes from install to your first semantic diff. You need Node.js 24 or
newer and a git repository.

## 1. Install

Install the CLI and a language plugin, then add framework and effects plugins
for whatever your project uses. [Supported stacks](./supported-stacks.md)
lists them all.

::: code-group

```bash [pnpm]
pnpm add -D @aburi/cli @aburi/lang-typescript @aburi/framework-next @aburi/framework-react
```

```bash [npm]
npm install -D @aburi/cli @aburi/lang-typescript @aburi/framework-next @aburi/framework-react
```

```bash [yarn]
yarn add -D @aburi/cli @aburi/lang-typescript @aburi/framework-next @aburi/framework-react
```

```bash [bun]
bun add -D @aburi/cli @aburi/lang-typescript @aburi/framework-next @aburi/framework-react
```

:::

The rest of this page writes the commands bare. Run them through whichever
package manager you installed with:

::: code-group

```bash [pnpm]
pnpm exec aburi <command>
```

```bash [npm]
npx aburi <command>
```

```bash [yarn]
yarn aburi <command>
```

```bash [bun]
bunx aburi <command>
```

:::

## 2. Create a config

```bash
aburi init
```

`init` looks at your repository, works out the workspace layout, languages, and
frameworks, and reports what it found:

```
✓ Wrote /home/you/shop/aburi.json
  managers: pnpm
  languages: ts
  frameworks: nextjs, react
  components: 1
```

The file it wrote names the plugins to load and the components it detected:

```json
{
  "$schema": "https://aburi.kage1020.com/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": ["framework-next", "framework-react"],
  "components": [
    {
      "id": "storefront",
      "name": "storefront",
      "roots": ["apps/storefront"],
      "languages": ["ts"],
      "frameworks": ["nextjs", "react"]
    }
  ]
}
```

Everything else has a default, and [Configuration](./configuration.md) covers
the knobs you may want later.

::: tip
`aburi init --with-suggestions` adds a comment naming the plugin packages it
found in your project but not in your dependencies.
:::

## 3. Scan

```bash
aburi scan
```

The first line is the symbol census, the second says how much of the call graph
resolved, and the arrows name what was written:

```
184 kept · 63 dropped · 212 files
calls 1043 · resolved 917 · unresolved 126 (external 108 · dynamic 14 · no-match 4)
→ /home/you/shop/out/aburi.ir.json
→ /home/you/shop/out/workspace.md
```

Three things land in `out/`:

| File | What it is |
|---|---|
| `aburi.ir.json` | The analysis itself, as JSON. Everything else derives from it. |
| `workspace.md` | One page covering the whole repository: components, dependencies, effect surface. |
| `components/*.md` | Per-component detail. Every kept symbol with its boundaries, rules, and effects. |

Open `workspace.md` first. On a codebase you have never seen, it is the fastest
map you will get.

## 4. Diff two revisions

```bash
aburi diff main..HEAD --fail-on 'removed,changed:>20'
```

The glyph line is the summary — added, removed, changed, moved, moved+changed:

```
+2 -1 ~3 ↔0 ⤴0
calls 1043 · resolved 917 · unresolved 126 (external 108 · dynamic 14 · no-match 4)
→ /home/you/shop/out/diff.md
```

`out/diff.md` is the report you hand to a reviewer, and `out/diff.json` sits
beside it. A tripped `--fail-on` clause prints the reason on stderr and exits
`3`, which is what CI gates on:

```
--fail-on removed tripped (observed: 1 removed)
```

See [CI integration](./ci-integration.md).

::: warning Quote the `--fail-on` value
`>` is a redirect in every shell. `--fail-on changed:>5` writes a file called
`5`. `--fail-on 'changed:>5'` sets a threshold.
:::

[Reading the report](./reading-the-report.md) explains what comes out.

## 5. Zoom in on one symbol

When the diff flags something and you want the full picture:

```bash
aburi explain submitOrder
```

The symbol's Markdown goes to stdout, so you can pipe it into a pager or a file:

```md
# `submitOrder` *(function)*

**File**: `apps/storefront/src/app/orders/actions.ts:5-12`
**Visibility**: public
**Language**: ts

## Signature

`(cart: Cart) → Promise<Order>` throws EmptyCart ⚡async

## Rules

- guard: `cart.items.length === 0` (L6)
- throw: `EmptyCart` (L7)

## Calls

- `EmptyCart` (L7)
- `createOrder` (L9)
- `sendReceipt` (L10)

## Derived by

- `export-keyword`

## Fingerprint

- api: `94f035a1f334`
- logic: `708d436dac4a`
- syntax: `d64c00d2efc8`
```

Sections for the component, decorators, effects, and callers appear whenever the
analysis has them. Pass a symbol name, a file path, or a full symbol id — Aburi
works out which one you meant. `--output <path>` writes the Markdown to a file
instead.

## Where to go next

- [Reading the report](./reading-the-report.md) explains each section.
- [Configuration](./configuration.md) covers every field of `aburi.json`.
- [CI integration](./ci-integration.md) runs this on every pull request.
- [CLI reference](../reference/cli.md) lists every flag and exit code.
