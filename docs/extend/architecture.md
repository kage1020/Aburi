# Architecture

This page is for people working *on* Aburi, or writing a plugin for it. If you
just want to use the tool, the [guide](/guide/what-is-aburi) is the better
starting point.

## One artifact, many views

Everything Aburi produces comes from a single JSON document,
`out/aburi.ir.json` — the intermediate representation, or IR. It is the only
thing the pipeline writes; the Markdown reports, the diff, and `explain` are all
derived from it after the fact.

That has one consequence worth stating plainly: **the same IR always yields the
same output.** No renderer reads source files, and no renderer makes a judgement
the IR does not already record. If a report is wrong, the IR is wrong.

## The pipeline

`aburi scan` runs seven stages. Plugins own three of them.

| Stage | Owner | What happens |
|---|---|---|
| 1. Discover | `@aburi/core` | Walk the workspace, apply `ignore` and `.gitignore`, assign files to components. |
| 2. Parse | *language plugin* | `parseFile` produces a tree-sitter tree and the file's import edges. |
| 3. Extract | *language plugin* | `extractSymbols` yields symbol candidates; `walkBody` collects rules and calls from each body. |
| 4. Classify | *framework plugin*, *effects plugin* | `classifySymbol` assigns framework kinds and boundaries; `classify` turns calls into effects. |
| 5. Drop | `@aburi/core` | Remove boilerplate — interfaces, DTOs, re-exports, empty bodies — plus whatever `suppress` names. |
| 6. Resolve | `@aburi/core` | Match calls to the symbols they reach, filling in the dependency graph. |
| 7. Fingerprint | `@aburi/core` | Hash each symbol three times — `api`, `logic`, `syntax` — and check the IR's invariants. |

The three fingerprints are what make the diff refactor-tolerant. `syntax` covers
the literal normalised body, `logic` covers control flow and effects, `api`
covers the public surface. A reformatting pass changes only `syntax`, so the
report can say "nothing happened here" with confidence.

`aburi diff` runs the pipeline twice, then matches symbols across the two
documents in five stages — by id, by git rename, by logic fingerprint, by name
and signature, and finally by weak match among dropped symbols — before
computing the status and delta for each.

## Packages

| Package | What it owns |
|---|---|
| `@aburi/types` | Types generated from the JSON Schemas, plus the hand-written plugin interfaces. |
| `@aburi/plugin-registry` | Manifest validation and vocabulary ownership — which plugin may emit which namespace. |
| `@aburi/config` | Loading and validating `aburi.json`. |
| `@aburi/core` | Symbol ids, canonical JSON, IR invariants, autodetect, and the scan pipeline. |
| `@aburi/diff` | The five-stage matcher, statuses, and deltas. |
| `@aburi/markdown-projection` | Every Markdown view, and the `--fail-on` formatter. |
| `@aburi/cli` | The four commands, git worktree handling, and exit codes. |
| `@aburi/github-action` | A composite action wrapping the CLI, with marker-based comment upsert. |
| `@aburi/lang-*` | Language plugins. |
| `@aburi/framework-*` | Framework plugins. |
| `@aburi/effects-*` | Effects plugins. |

## Schemas

Four JSON Schemas under [`schema/`](https://github.com/kage1020/Aburi/blob/main/schema/)
define the contracts: `aburi.ir.v1` for the analysis, `aburi.diff.v1` for the
diff, `aburi.config.v1` for the config, and `aburi.plugin.v1` for plugin
manifests. The `v1` schemas are frozen — additive changes only.

## Going deeper

The [design documents](/design/overview) specify every stage above in full, and
are the reference an implementation is expected to cite. To write a plugin,
start with [Plugin development](/extend/plugin-development).
