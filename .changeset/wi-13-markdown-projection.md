---
"@aburi/markdown-projection": minor
---

Add the deterministic Markdown projection engine — `@aburi/markdown-projection` — that turns any `aburi.ir.v1` document (and, optionally, an `aburi.diff.v1` output) into human + AI-readable Markdown views. Delivers every WI-13 acceptance criterion from `design/details/markdown-projection.md`.

### Projections

- **`projectWorkspace(ir)`** (§4 — `workspace.md`) — Managers / Languages / Symbol counts header, Components table (with per-component symbol counts), `graph LR` mermaid dependency diagram with an always-attached text fallback and a `MERMAID_NODE_LIMIT` (100) auto-fallback for oversized graphs, and the top-`EFFECT_SURFACE_TOP_N` (10) effect surface table sorted by count.
- **`projectComponent({component, symbols, dependencies})`** (§5 — `components/<id>.md`) — Component header (Roots / Languages / Frameworks / Symbols counts), Public API list, Dependencies list, `## Symbols` grouped by file with §3.2 ordering (`startLine` primary, `id` tiebreaker), and a `## Dropped` `<details>` fold-out (§3.6). §5.3 section-omit rules are applied: empty `decorators` / `signature: null` / empty `rules|effects|calls` skip the row, zero fingerprints skip the `<sub>` line.
- **`projectSymbolExplain(symbol)`** (§7 — `aburi explain`) — Stand-alone Symbol view with dedicated `## Boundary` / `## Decorators` / `## Signature` / `## Rules` / `## Effects` / `## Calls` / `## Derived by` / `## Fingerprint` sections. Dropped Symbols fall back to a 3-line summary (name + drop reason + IR-contract note).
- **`projectDiff(diff)`** (§6 — `diff.md`) — Ten sections in importance order: `## ⚠ API 変更` / `## 🔧 Logic 変更` / `## ➕ Added` / `## ➖ Removed` / `## 🔀 Moved + Changed` / `## 🔀 Moved` (fold-out) / `## 🧱 Component changes` / `## 🔗 Dependency changes` / `## 💧 Dropped 変動` (fold-out) / `## 🎨 Syntax-only 変更` (fold-out). Changed entries are routed by delta priority: `apiChanged` > `logicChanged` > `syntaxChanged` so an entry is never double-counted across sections. Empty sections are dropped entirely so PR comments stay tight.
- **`projectDiffSummaryLine(diff)`** (§6.3) — Compact `+A -R ~C ↔M ⤴MC` string for CLI stdout.

### Confidence badges & shared formatters

- `confidenceBadge` (§3.5) — `high` → no badge, `medium` / `low` → `⚠ <level>`.
- `signatureLine`, `ruleRow` (§5.6 seven RuleType shapes), `effectRow` (§5.7), `callRow` (§5.8), `fingerprintLine` (§5.9), `decoratorRows` (§5.4), `codeFragment` (§3.4 inline vs. fenced) — pure text primitives reusable across projections.

### Sanitisation (§8)

- `sanitizeSymbolId(id)` — `:` / `/` / `#` / `.` → `-`, consecutive dashes collapse, leading/trailing dashes trim.
- `collisionSuffix(id)` — deterministic `SHA-256(UTF-8(id))` first 3 bytes as 6-char hex.
- `withCollisionSuffix(id)` — always-append form.
- `assignSymbolFilenames(ids)` — batch resolver: keeps base names on unique inputs, appends `-<hash>` to both sides of a collision.

### `--fail-on` formatter (WI-13 AC 5)

- `FailOnClause` (`status` + optional `comparator` + `count`) with sub-directions `dropped-toggled:to-dropped` / `dropped-toggled:to-kept`.
- `formatFailOnClause` → argument-form string (`changed:>10`).
- `formatFailOnTriggered(clause, observed)` → stable CI-log phrasing.
- `evaluateFailOn(clause, summary, breakdown?)` → `{triggered, observed}` with strict `>` / `>=` / `==` / `<=` semantics.

### Tests

37 tests across `test/{mp-properties, sanitize, fail-on}.test.ts` cover MP1..MP12 verifiables, sanitisation + collision (MP9), and every `--fail-on` comparator / bare-status combination.
