# Getting started

## Requirements

- Node.js `>= 24`
- A package manager (examples below use pnpm)

## Install

```bash
pnpm add -D @aburi/cli @aburi/lang-typescript @aburi/framework-nestjs
```

Pick the plugins that match your stack:

- Frameworks: `@aburi/framework-nestjs`, `@aburi/framework-next`
- Effects: `@aburi/effects-prisma`, `@aburi/effects-nest`

## Initialise

```bash
pnpm exec aburi init
```

`aburi init` autodetects the workspace (pnpm / npm workspaces), languages,
frameworks, and components, and writes `aburi.json`:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["typescript"],
  "frameworks": ["nestjs"]
}
```

Add `--with-suggestions` to get install-command hints for detected first-party
plugins as JSONC comments.

## Scan the workspace

```bash
pnpm exec aburi scan
```

This emits:

- `out/aburi.ir.json` — canonical JSON, `aburi.ir.v1` schema (the source of truth)
- `out/workspace.md` — L0 workspace overview
- `out/components/*.md` — L1 + L2 per-component detail

## Diff a PR

```bash
# Quote --fail-on: `>` is a shell redirect if left bare.
pnpm exec aburi diff main..HEAD --fail-on 'changed,removed:>5'
```

This emits:

- `out/diff.json` — `aburi.diff.v1` schema
- `out/diff.md` — review-facing Markdown

Exit code `0` means clean; `3` means a `--fail-on` gate tripped — that's the
code CI pipelines gate on. See the [CLI reference](/cli-reference) for the full
exit-code table and `--fail-on` grammar.

## Explain a single Symbol

```bash
pnpm exec aburi explain applyRefund
pnpm exec aburi explain src/billing/billing.service.ts
pnpm exec aburi explain 'ts:src/billing/billing.service.ts#BillingService.applyRefund'
```

## Next steps

- [CI integration](/guide/ci-integration) — wire the diff gate into GitHub Actions.
- [Plugin development](/plugin-development) — add support for your language or framework.
