---
"@aburi/cli": patch
---

`aburi init --force` now says on stderr when it replaced an existing config (`⚠ Overwrote <path>; the config that was there is gone.`). It used to replace the file without a word, so a hand-written `components` or `ignore` list could vanish unnoticed.

`aburi init --with-suggestions` names only the plugins the workspace has not installed. It used to suggest every plugin it mapped a detected language or framework to, installed or not. A plugin counts as installed when a `node_modules/@aburi/<name>` directory sits in the workspace root or above it, the directories an ESM import from there searches.

The help text of `scan --no-timestamp` says what it drops, `discoveredAt` from `aburi-vocab-discovered.json`: the IR never carries a timestamp. The help of `init --respect-gitignore` / `--no-respect-gitignore` names the nx project search beside the language census.
