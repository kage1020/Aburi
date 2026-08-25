# Getting started

Five minutes from install to your first semantic diff. You need Node.js 24 or
newer and a git repository.

## 1. Install

Install the CLI plus a language plugin. Add framework and effects plugins for
whatever your project uses — [Supported stacks](/guide/supported-stacks) lists
them all.

::: code-group

```bash [pnpm]
pnpm add -D @aburi/cli @aburi/lang-typescript @aburi/framework-nestjs
```

```bash [npm]
npm install -D @aburi/cli @aburi/lang-typescript @aburi/framework-nestjs
```

```bash [yarn]
yarn add -D @aburi/cli @aburi/lang-typescript @aburi/framework-nestjs
```

:::

## 2. Create a config

```bash
pnpm exec aburi init
```

`init` looks at your repository — workspace layout, languages, frameworks — and
writes `aburi.json`:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": ["framework-nestjs"]
}
```

That is the whole file. Everything else has a default, and
[Configuration](/guide/configuration) covers the knobs you may eventually want.

::: tip
`aburi init --with-suggestions` adds a comment naming the plugin packages it
detected but you have not installed yet.
:::

## 3. Scan

```bash
pnpm exec aburi scan
```

Three things land in `out/`:

| File | What it is |
|---|---|
| `aburi.ir.json` | The analysis itself, as JSON. Everything else is derived from it. |
| `workspace.md` | One page describing the whole repository: components, dependencies, effect surface. |
| `components/*.md` | Per-component detail — every kept symbol, its boundaries, rules, and effects. |

Open `workspace.md` first. On an unfamiliar codebase it is the fastest map you
will get.

## 4. Diff two revisions

```bash
pnpm exec aburi diff main..HEAD --fail-on 'changed,removed:>5'
```

This writes `out/diff.md` (the review-facing report) and `out/diff.json`, then
exits `3` if a `--fail-on` clause tripped. That exit code is what CI gates on —
see [CI integration](/guide/ci-integration).

::: warning Quote the `--fail-on` value
`>` is a redirect in every shell. `--fail-on changed:>5` writes a file called
`5`; `--fail-on 'changed:>5'` sets a threshold.
:::

[Reading the report](/guide/reading-the-report) explains what comes out.

## 5. Zoom in on one symbol

When the diff flags something and you want the full picture:

```bash
pnpm exec aburi explain applyRefund
```

The argument can be a symbol name, a file path, or a full symbol id — Aburi
figures out which you meant.

## Where to go next

- [Reading the report](/guide/reading-the-report) — what each section means.
- [CI integration](/guide/ci-integration) — run this on every pull request.
- [CLI reference](/reference/cli) — every flag, every exit code.
