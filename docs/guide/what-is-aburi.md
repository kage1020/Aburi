# What is Aburi?

Aburi extracts a **semantic intermediate representation (IR)** from source code
so reviewers can read pull requests at the level of business logic, control
flow, and module boundaries instead of raw diffs.

It reproduces, as a tool, the process a senior engineer performs mentally during
code review: strip the decoration and look only at meaningful control flow,
domain rules, and module boundaries.

Aburi is a **static analyser**, not an LLM judge. It parses with tree-sitter,
matches Symbols across revisions with a 5-stage semantic diff, and emits a JSON
IR plus a decision-focused Markdown projection that CI can gate on. The output
is fully deterministic: the same IR in always produces the same Markdown and
the same diff out.

## Why not just `git diff`?

`git diff` shows *what changed textually*. Aburi shows *what changed
semantically*:

- A file rename with unchanged logic surfaces as `moved: 1` — not
  `removed + added`.
- Adding a validation guard to a method surfaces as
  `changed: 1, logicChanged: true` — and can be gated in CI via
  `--fail-on changed:>0`.
- Boilerplate (interfaces, re-exports, empty bodies) is dropped from the diff
  so the reviewer sees only the changes that carry meaning.
- A refactor that stubs 12 method bodies surfaces as
  `dropped-toggled:to-dropped: 12` with a single-token CI gate
  (`--fail-on dropped-toggled:to-dropped:>10`).

## Primary use cases

- Review large AI-generated implementation diffs at business-logic and
  architecture granularity.
- Help newcomers quickly understand the structure of a large codebase.
- Visualise per-PR change impact as a semantic diff instead of changed lines.

Aburi is optimised for **time-series comparison within one project** (PR diffs,
release-to-release, historical versions). Cross-project comparison is
secondary.

## Architecture at a glance

```
source files
  ↓ (@aburi/lang-typescript, @aburi/lang-*)          tree-sitter parseFile / extractSymbols
  ↓ (@aburi/framework-nestjs, @aburi/framework-next) classifySymbol → extKind (framework:*)
  ↓ (@aburi/effects-prisma, @aburi/effects-nest)     classifyCall → Effect (db.read / event.publish / …)
  ↓ (@aburi/core scan)                               walkBody → Rules + Calls + Effects
  ↓                                                  drop rules (interfaces, empty bodies, re-exports)
  ↓                                                  fingerprint per Symbol (api / logic / syntax)
  ↓                                                  IR integrity check (11 invariants)
  ↓
aburi.ir.v1.json  ───────────────────────────────────  Source of Truth (L3)
  │
  ├─ @aburi/markdown-projection  workspace.md / component/*.md   (L0 / L1 / L2 views)
  ├─ @aburi/diff                 5-stage matcher → aburi.diff.v1  (base IR + head IR → diff)
  └─ @aburi/cli explain          per-Symbol Markdown detail
```

Everything downstream of `aburi.ir.v1.json` is deterministically derived from
it. The full design rationale lives in the [design overview](/design/overview).

## Package matrix

| Package | Layer | What it does |
|---|---|---|
| `@aburi/types` | Foundation | Schema-generated IR / config / diff / plugin types + hand-written plugin interfaces. |
| `@aburi/plugin-registry` | Foundation | Plugin manifest validator + vocab registry (owned extKinds / effect ids / namespaces). |
| `@aburi/config` | Foundation | JSONC + ajv-validated `aburi.json` loader with framework-hint normalisation. |
| `@aburi/core` | Foundation | Symbol ID generation, canonical JSON, 11 IR invariants, autodetect, scan orchestration. |
| `@aburi/lang-typescript` | Language | TS/TSX language plugin (tree-sitter WASM), JSDoc-aware signature + throws, drop-hint contract. |
| `@aburi/framework-nestjs` | Framework | `@Module` / `@Controller` / `@Injectable` / HTTP + WS + pattern decorators → `framework:nestjs:*` extKinds. |
| `@aburi/framework-next` | Framework | App Router files (page / layout / route / …) → `framework:next:*` extKinds. |
| `@aburi/effects-prisma` | Effects | `prisma.<model>.<verb>` / `$transaction` → `db.read` / `db.write` / `db.transaction`. |
| `@aburi/effects-nest` | Effects | `EventEmitter2` / `eventBus` `.emit(...)` → `event.publish`. |
| `@aburi/diff` | Diff | 5-stage matcher (id / git-rename / logic-fingerprint / name+signature / dropped-weak) + status + delta. |
| `@aburi/markdown-projection` | Projection | Workspace / component / diff / explain Markdown views + `--fail-on` formatter. |
| `@aburi/cli` | CLI | `aburi init / scan / diff / explain`, git-worktree ref diff, exit codes, `--fail-on` gate. |
| `@aburi/github-action` | Delivery | Composite GH Action wrapper around the CLI, marker-based PR comment upsert. |

## Next steps

- [Getting started](/guide/getting-started) — install, init, scan, diff.
- [CI integration](/guide/ci-integration) — gate PRs and post review comments.
- [CLI reference](/cli-reference) — every flag and exit code.
