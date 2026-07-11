# Aburi

A library that reproduces, as a tool, the process a senior engineer performs mentally during code review: stripping away decoration and looking only at meaningful control flow, domain rules, and module boundaries.

For the roadmap and per-version scope, see [`roadmap.md`](../roadmap.md). Detailed designs live in this directory.

---

## 1. Purpose and Use Cases

Aburi outputs an **intermediate representation (IR)** that is neither full source code nor a natural-language summary.

### Primary use cases
- Review large AI-generated implementation diffs at the granularity of business logic and architecture
- Let newcomers quickly understand the structure of a large codebase
- Visualize the impact of a change per PR as a semantic diff rather than lines of code

### Primary comparison axis
**Time-series comparison within the same project** (PR diffs, between releases, against past versions) is the first-class use case and what the design optimizes for. Cross-project comparison is secondary.

## 2. Core Design Decisions

| Decision | Adopted | Rejected, and why |
|---|---|---|
| IR format | JSON, fixed (Markdown is a deterministic derivation) | Markdown as primary IR (weak machine processing / schema validation) |
| Config format | JSONC (`biome.json` style) | TypeScript / YAML (no dynamic logic needed; static is better given AI integration) |
| Extraction strategy | "Drop" as primary, "keep" as secondary | Defining only "what to keep" (decoration is finite, logic is infinite) |
| Parser layer | Tree-sitter core, always resident + optional LSP enrichment | LSP only (unstable in CI; large per-language variance) |
| Structural interpretation | Static heuristics + symbol graph | LLM judgment (verifiability and diff stability disappear) |
| Diff stability | Semantic ID + 3-layer fingerprint (`api`/`logic`/`syntax`) + rename tracking | Line-based diff |
| Diff statuses | `added`/`removed`/`moved`/`changed`/`moved+changed` | `added`/`removed` only (loses trust on file moves) |
| Configuration philosophy | Robust defaults + minimal overrides | Highly configurable (time-series comparison breaks on config updates) |
| Language vocabulary | Common core vocabulary + language extensions (`<namespace>:<kind>`) | Core vocabulary only (cannot express functional ADT/match etc.) |
| Confidence | Categorical (`high` / `medium` / `low`) | Numeric (breeding ground for false precision) |
| Delivery | CLI + bundled GitHub Action wrapper | CLI only / Web UI |

## 3. Output Architecture

### 3.1 Horizontal layers

```
L0: workspace overview     (dependency direction / component boundaries — full monorepo view)
L1: component architecture (public API / side-effect boundaries / owning modules)
L2: module logic           (control flow / rules / effects — per function/method)
L3: symbol IR (JSON)       ← Source of Truth
```

L3 is the truth. L0/L1/L2 are all Markdown derived deterministically from L3.

### 3.2 Vertical view (Slice View)

Horizontal layers are good at bundling like with like, but for a single feature addition that cuts vertically through Controller→Service→Repository→Migration, the diff scatters.

**Slice View**: cluster the set of changed symbols into connected components over the call graph and display them as vertical slices (per feature). It is derived from the same L3 IR.

## 4. Extraction Pipeline

```
source files
  ↓ tree-sitter parse  (+ LSP enrich if available)
AST
  ↓ drop list (.scm queries + decoration callee set)
filtered AST
  ↓ tag propagation
   - Boundary:  framework decorator / exported symbol / route handler
   - Effect:    db.* / network.* / queue.* / event.* / fs.* / state.* / time.* / random / env.* / process.*
   - Rule:      guard (if + throw/return) / loop / try / switch / match / non-trivial return
   - DataModel: interface / type alias / pure DTO
   - language extensions:  fp:match / fp:adt / fp:effect / oop:abstract / meta:macro ...
  ↓ score & filter (symbols with no tags are dropped)
symbols
  ↓ normalize (callee whitespace, expression canonicalize, sort)
  ↓ call resolution (fill in Symbol.calls[].resolved → CallEdge[])
  ↓ effect propagation (augment Symbol.effects[] along resolved edges)
  ↓ fingerprint (api / logic / syntax)
L3 IR (JSON)
  ↓ project
L2 / L1 / L0 Markdown + Slice View (for time-series diffing)
```

Details are covered by the documents in this directory:
- Core extraction rules: [`drop-list.md`](./drop-list.md)
- Effect plugin interface: [`effect-plugin.md`](./effect-plugin.md)
- Language plugin interface: [`lang-plugin.md`](./lang-plugin.md)
- Fingerprint computation: [`fingerprint.md`](./fingerprint.md)
- Call resolution (filling in `Call.resolved`): [`call-resolution.md`](./call-resolution.md)
- Effect propagation (augmenting `Symbol.effects[]` along resolved edges): [`effect-propagation.md`](./effect-propagation.md)

## 5. IR and Config

The IR schema (`aburi.ir.v1`) is defined in [`ir-schema.md`](./ir-schema.md); the JSON Schema is [`schema/aburi.ir.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.ir.v1.json).

The configuration file is `aburi.json` or `aburi.jsonc` (workspace root). Details in [`config.md`](./config.md).

**Deliberately not configurable** (to keep time-series comparison stable):
- score weights
- output ordering
- IR schema
- AST traversal details
- raw per-language node kind specification

Config is version-controlled; when regenerating a past IR, the operational rule is to check out the Config of that time from git and use it.

## 6. CLI

```bash
aburi init                       # generate config (autodetect: workspace manager / framework / language)
aburi scan                       # generate full IR → out/ir.json + out/workspace.md + out/components/*.md
aburi diff <base>..<head>        # semantic diff → out/diff.md (for pasting as a PR comment)
aburi explain <file-or-symbol>   # L2 Markdown for a single symbol to stdout
```

Automatic PR comment posting is bundled as a thin `@aburi/github-action`. Detailed CLI specification: [`cli-spec.md`](./cli-spec.md).

## 7. Diff Strategy

| Status | Detection method |
|---|---|
| `added` | Symbol absent from the old IR and present in the new IR |
| `removed` | Symbol present in the old IR and absent from the new IR |
| `moved` | git rename detection + differing path but matching remainder of the symbol ID, or fingerprint match |
| `changed` | Same ID with a change in either the `api` or `logic` fingerprint |
| `moved+changed` | Renamed and the fingerprint changed as well |

Move detection pipeline:
```
1. Obtain the physical rename mapping via git diff --find-renames
2. Symbols not covered by (1) are matched by logic fingerprint equality
3. Anything still unmatched is matched by name + signature similarity (with a threshold)
4. Anything beyond that is treated as add + remove
```

A pure `moved` (no semantic change) is explicitly labeled "move only" in the diff report, reducing review load to zero. Algorithm details: [`diff-algorithm.md`](./diff-algorithm.md).

## 8. Non-Goals

Explicitly out of scope:

- Semantic judgment by an LLM (verifiability and diff stability disappear)
- Beautiful SVG visualization (diff-unstable / overlaps with existing tools)
- Lint use cases (Biome/ESLint own that)
- Natural-language summaries (that is the job of whatever consumes the IR downstream, e.g. an AI)
- Exposing score weights in configuration
- Tracking the IR in git (by default)

## 9. Failure Patterns and Mitigations

| Failure | Mitigation |
|---|---|
| "Plausible-looking summary that cannot be trusted" | Every IR element carries `source range` + `confidence` (`high`/`medium`/`low`) + `derivedBy` |
| Over-abstraction drops edge cases and yields a false LGTM | "Drop" takes priority; guard/throw is always kept; low confidence is called out explicitly in the report |
| Minor refactors turn the diff bright red | Semantic ID + 3-layer fingerprint + normalization pass |
| File moves produce mass add/remove | git rename detection + fingerprint matching + `moved` status |
| Config updates break time-series comparison | Strictly limit configurable options; config is itself version-controlled |
| Functional languages become inexpressible | Two-layer vocabulary: core + language extensions (`<namespace>:<kind>`) |
| AI progress erases the IR's reason to exist | "A diff representation that is easy for AI to read" is itself the primary value — smaller, faster, and more reliable than reading all code directly |

## 10. Project Layout

```
Aburi/
├─ docs/
│  ├─ design/
│  │  ├─ overview.md            ← this document
│  │  └─ ...                    ← detailed designs (IR schema / plugin IF / fingerprint / diff / ...)
│  └─ roadmap.md                ← per-version scope progression
├─ schema/                      ← JSON Schema (IR / config)
├─ packages/                    ← published npm packages. Naming: @aburi/<type>-<name>
│  ├─ core/                     ← @aburi/core (pipeline itself)
│  ├─ cli/                      ← @aburi/cli (aburi command)
│  ├─ lang-typescript/          ← @aburi/lang-typescript    (type=lang)
│  ├─ framework-nestjs/         ← @aburi/framework-nestjs    (type=framework)
│  ├─ framework-nextjs/         ← @aburi/framework-nextjs    (type=framework)
│  ├─ effects-nest/             ← @aburi/effects-nest        (type=effects, xPrefix=nest)
│  ├─ effects-prisma/           ← @aburi/effects-prisma      (type=effects, xPrefix=prisma)
│  └─ github-action/            ← @aburi/github-action
└─ examples/                    ← sample monorepo (tests + documentation)
```

Tooling: Vite (bundle) / Vitest (test) / Biome (lint+format) / pnpm workspaces.
