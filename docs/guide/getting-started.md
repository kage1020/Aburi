# Getting started

Five minutes from install to your first semantic diff. You need Node.js 24 or
newer and a git repository.

## 1. Install

Install the CLI and a language plugin, then add framework and effects plugins
for whatever your project uses. [Supported stacks](/guide/supported-stacks)
lists them all.

::: code-group

```bash [pnpm]
pnpm add -D @aburi/cli @aburi/lang-typescript \
  @aburi/framework-next @aburi/framework-react
```

```bash [npm]
npm install -D @aburi/cli @aburi/lang-typescript \
  @aburi/framework-next @aburi/framework-react
```

```bash [yarn]
yarn add -D @aburi/cli @aburi/lang-typescript \
  @aburi/framework-next @aburi/framework-react
```

:::

## 2. Create a config

```bash
pnpm exec aburi init
```

`init` looks at your repository, works out the workspace layout, languages, and
frameworks, and writes `aburi.json`:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": ["framework-next", "framework-react"]
}
```

That is the whole file. Everything else has a default, and
[Configuration](/guide/configuration) covers the knobs you may want later.

::: tip
`aburi init --with-suggestions` adds a comment naming the plugin packages it
found in your project but not in your dependencies.
:::

## 3. Scan

```bash
pnpm exec aburi scan
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
pnpm exec aburi diff main..HEAD --fail-on 'changed,removed:>5'
```

You get `out/diff.md`, the report you hand to a reviewer, and `out/diff.json`
beside it. A tripped `--fail-on` clause exits `3`, which is what CI gates on.
See [CI integration](/guide/ci-integration).

::: warning Quote the `--fail-on` value
`>` is a redirect in every shell. `--fail-on changed:>5` writes a file called
`5`. `--fail-on 'changed:>5'` sets a threshold.
:::

[Reading the report](/guide/reading-the-report) explains what comes out.

## 5. Zoom in on one symbol

When the diff flags something and you want the full picture:

```bash
pnpm exec aburi explain submitOrder
```

Pass a symbol name, a file path, or a full symbol id. Aburi works out which one
you meant.

## Where to go next

- [Reading the report](/guide/reading-the-report) explains each section.
- [CI integration](/guide/ci-integration) runs this on every pull request.
- [CLI reference](/reference/cli) lists every flag and exit code.
