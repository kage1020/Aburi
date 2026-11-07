---
"@aburi/core": patch
---

`workspace.managers[]` now holds one entry per tool. A pnpm workspace that declares its packages in both `pnpm-workspace.yaml` and `package.json#workspaces`, with `pnpm-lock.yaml` beside them, listed pnpm twice: the IR read `[{"tool":"pnpm","roots":["packages/a"]},{"tool":"pnpm","roots":["packages/a"]}]`, the `workspace.md` header `pnpm (packages/a), pnpm (packages/a)`, and `aburi init` printed `managers: pnpm, pnpm`. The two entries are now one, whose `roots` are every root either manifest declares. Components were already detected once per directory and do not change.

An IR scanned before this release, compared with one scanned after, differs only in `workspace.managers`, which no fingerprint reads, so `aburi diff` reports no Symbol for it.
