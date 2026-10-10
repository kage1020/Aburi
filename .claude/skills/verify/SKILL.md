---
name: verify
description: Run Aburi's four CI checks (Biome, typecheck, tests, build) the way CI does and read the result honestly. Use before committing, before opening a PR, or when asked to "check", "verify" or "make sure it's green".
---

# Verify the workspace

CI runs the same four commands on Ubuntu, macOS and Windows. Run them from the repository root:

```bash
pnpm check                                  # Biome lint + format (pnpm format writes fixes)
pnpm turbo run typecheck --force
pnpm turbo run test --force --continue
pnpm turbo run build --force
```

`--force` matters: turbo replays cached output, old timestamps included, so a rerun without it can show a
pass that never executed. The footer must read `Cached: 0 cached`.

Turbo prints a task's log only when it fails (`outputLogs: errors-only`) and vitest prints console output
only for failing tests (`silent: "passed-only"`), so a green run is a few summary lines. Read the
`Tasks:` / `Failed:` footer, not the scroll.

## While iterating on one package

```bash
cd packages/<name>
pnpm exec vitest run [test/file.test.ts]
pnpm exec tsc -p tsconfig.json --noEmit
```

A package's tests import its own `src`, every other published `@aburi/*` package through its built
`dist`, and `@aburi/schema`, `@aburi/test-support` and `@aburi/test-harness` from source (no build needed).
After changing a published package other suites depend on, rebuild it through turbo
(`pnpm turbo run build --filter=<pkg>`) before trusting their results; `packages/cli/test/e2e` runs the real
pipeline over built plugins and the CLI's own built bin.

## Known local-only failure

`packages/github-action/test/resolve-cli-bin.test.ts` › "anchors on the working directory, not on its own
location" fails in a long-lived checkout, where vitest's `NODE_PATH` exposes `@aburi/cli` from the pnpm
store; it passes after a fresh install and in CI. Report it as known rather than "fixing" it.

## Reporting

State which commands ran, with `--force`, and the footer of each. If anything failed, quote the failing
test names and the first assertion message. Do not describe a skipped or cached step as passing.
