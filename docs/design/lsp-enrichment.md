# LSP Enrichment

Specification of the optional Language Server Protocol enrichment pass that refines Aburi's Tree-sitter-derived IR — filling in `SourceRange.startColumn` / `endColumn`, resolving typed method dispatch (`this.*` / `super.*` / interface receivers), and inferring throws from declared return types — without changing IR shape, ordering, or any fingerprint value.

References:
- [`overview.md`](./overview.md) §2 — the "Parser layer" decision row that adopts `Tree-sitter core, always resident + optional LSP enrichment` and rejects LSP-only for CI-stability reasons; §4 — the extraction pipeline placement (`tree-sitter parse (+ LSP enrich if available)`)
- [`call-resolution.md`](./call-resolution.md) §2 — the Two-Tier Resolution Model whose LSP tier this pass supplies inputs for; §5 — the LSP-enriched resolution rules; §7.2 — the per-edge confidence table this pass populates the `high` / `medium` rows of; §11.4 — the `@aburi/core` placement rationale mirrored here
- [`effect-propagation.md`](./effect-propagation.md) §3 — the `CallEdge[]` input that this pass indirectly enlarges; §5.3 — the confidence combination that consumes lifted `CallEdge.confidence`
- [`slice-view.md`](./slice-view.md) §5.1 — the Edge set that clusters over the enriched `CallEdge` graph
- [`ir-schema.md`](./ir-schema.md) §7 — `Signature` (extended here with an optional `inferredThrows` field); §12 — `SourceRange` (existing optional `startColumn` / `endColumn` populated here); §15.2 — the non-breaking optional-field policy this pass relies on
- [`fingerprint.md`](./fingerprint.md) §3.1 — the `api` fingerprint input this pass MUST NOT perturb; §4.1 — the `logic` fingerprint input likewise; §5.1 — the `syntax` fingerprint input likewise
- [`lang-plugin.md`](./lang-plugin.md) §2.1 — Symbol existence and call sites are the plugin's authority, never LSP's; §2.2 — call resolution (and by extension LSP-tier resolution) is out of scope for the plugin; §4.7 — `PluginContext.workspaceRoot` supplies the LSP `rootUri`
- [`config.md`](./config.md) §5.4 — `pluginOptions` scope hosts server-specific opaque options; §11 — CLI override convention followed by `--lsp` / `--no-lsp`; §14.1 — the compatibility scope under which timeout defaults live

---

## 1. Purpose

Aburi's Tree-sitter tier produces a complete, deterministic IR without any language server. This document specifies the **optional** LSP enrichment pass that refines four aspects of that IR:

1. `Call.resolved` for shapes the untyped tier leaves `null` — `this.*` / `super.*` calls whose receiver class is resolvable through the type system, and interface-typed receivers with a single implementer
2. `SourceRange.startColumn` / `SourceRange.endColumn` — populated from `textDocument/documentSymbol`; currently emitted as `null` by the language plugin
3. `Signature.inferredThrows` — a new optional array capturing throws declared on the return types of called functions (distinct from `Signature.throws`, which stays reserved for explicit `throw` statements + `@throws` JSDoc)
4. `CallEdge.confidence` — monotone-upward promotion from the untyped tier value to `high` / `medium` per [`call-resolution.md`](./call-resolution.md) §7.2

**Non-goal**: LSP is NEVER the source of truth for the existence of a Symbol, for the set of its call sites, or for its owning file. Those come from the language plugin ([`lang-plugin.md`](./lang-plugin.md) §2.1). This pass only refines already-emitted records.

The "optional" framing is required by [`overview.md`](./overview.md) §2: LSP-only was explicitly rejected for CI-stability and per-language variance reasons. Tree-sitter runs always; LSP runs when configured and available.

## 2. Pass Placement in the Pipeline

```
source files
  ↓ tree-sitter parse
  ↓ extractSymbols + walkBody + normalizeAst        ← language plugin
SymbolCandidate[] with columns = null and untyped calls
  ↓ LSP enrichment (this document)                  ← @aburi/core, opt-in
SymbolCandidate[] with columns, receiverTypes, implementers, inferredThrows
  ↓ call resolution (fills Call.resolved)           ← consumes LSP inputs (call-resolution.md §5)
  ↓ effect propagation
  ↓ fingerprint
L3 IR
```

The pass MUST run **after** every workspace file has been parsed (LSP `didOpen` needs the full workspace open before position queries return correct types) and **before** call resolution's LSP tier consumes the enriched receiver-type inputs.

The pass lives in `@aburi/core`, not in a language plugin. A single LSP session serves many files across the run; a `LanguagePlugin` instance is a per-file abstraction ([`lang-plugin.md`](./lang-plugin.md) §3). This mirrors [`call-resolution.md`](./call-resolution.md) §11.4.

## 3. Inputs and Preconditions

| Input | Origin | Notes |
|---|---|---|
| `SymbolCandidate[]` | language plugin | one entry per Symbol; carries file, line ranges, target strings |
| `WorkspaceRoot` | `PluginContext.workspaceRoot` ([`lang-plugin.md`](./lang-plugin.md) §4.7) | absolute path passed to the server as `rootUri` |
| `lspConfig` | `Config.lsp` (§12) | server binary, timeouts, concurrency, opt-in flag |
| `languageServer` | spawned per language | one persistent stdio process per enabled language |

Preconditions:

1. LSP MUST be opt-in. `lsp.enabled` defaults to `false`. Rationale: [`overview.md`](./overview.md) §2 rejects LSP-as-mandatory for CI-stability reasons; opt-in enrichment inherits the same concern for its own tier only.
2. `LanguagePlugin.capabilities.lspServer` MUST be non-null for a language before the pass considers that language; if null the pass is a no-op for every file of that language.
3. The server `command` MUST resolve on `PATH` or as an absolute path. If not, the pass triggers per-language fallback (§6.1).
4. Determinism MUST NOT depend on wall-clock server-response ordering; see §10.

## 4. LSP Communication Protocol Subset

### 4.1 Handshake

At scan start:

1. Spawn one server process per language for which `lsp.enabled` and `lsp.servers.<lang>` are both configured.
2. Send `initialize` with `rootUri = WorkspaceRoot`, `initializationOptions` from config (opaque, forwarded verbatim), and the client capability set `{ textDocument: { hover, typeDefinition, implementation, definition, documentSymbol } }`.
3. Wait for the `initialize` response within `initializeTimeoutMs`, then send `initialized`.

At scan end: send `shutdown`, wait for the response, send `exit`, then close the pipe. If the process has not exited within 1 second, `SIGKILL`.

One server process per language covers the whole run. Per-file open/close cycles happen inside a single resident process; the process is never restarted mid-run.

### 4.2 Request-to-IR-field mapping

Every LSP request the pass issues, the IR field it enriches, and the confidence the enriched value carries:

| LSP request | Position input | Response consumed | IR field enriched | Confidence |
|---|---|---|---|---|
| `textDocument/documentSymbol` | file URI | `DocumentSymbol[].range` (character offsets) | `SourceRange.startColumn`, `SourceRange.endColumn` | n/a (columns are not confidence-scored) |
| `textDocument/hover` | call site of `this.<m>` / `super.<m>` / `<receiver>.<m>` | receiver type text | `receiverType(callSite)` fed to [`call-resolution.md`](./call-resolution.md) §5.2 / §5.3 | `high` for direct class dispatch, `medium` for walked hierarchy ([`call-resolution.md`](./call-resolution.md) §7.2) |
| `textDocument/typeDefinition` | receiver position of an interface-typed call | destination symbol URI + range | resolves receiver to interface declaration for [`call-resolution.md`](./call-resolution.md) §5.3 lookup | `medium` (interface dispatch) |
| `textDocument/implementation` | interface declaration URI | array of implementer URIs | `implementers(interfaceName)` for [`call-resolution.md`](./call-resolution.md) §5.3 | `medium` when there is exactly one implementer; unresolved (no promotion) on multi-implementer cases unless a framework plugin hook narrows it |
| `textDocument/definition` | position of an otherwise-unresolved bare call target | destination URI + range | promotes `Call.resolved` from `null` to a workspace Symbol id | `medium` (last-resort LSP resolution) |
| `textDocument/hover` on called symbol's declaration | declaration position of `foo` where a call site `foo()` was written | throws clauses in the declared signature | append to `Signature.inferredThrows` (§7.1) | `medium` (inferred from declared type, not observed) |

Requests explicitly NOT used by this pass:

- `callHierarchy/incomingCalls` / `callHierarchy/outgoingCalls` — Tree-sitter already produces the call graph via `walkBody` ([`lang-plugin.md`](./lang-plugin.md) §4.4). Sourcing edges from LSP would duplicate the work and vary across servers. See §14.4.
- `textDocument/references` — reference resolution is the untyped tier's responsibility via `ImportEdge` ([`lang-plugin.md`](./lang-plugin.md) §4.4 / [`call-resolution.md`](./call-resolution.md) §4.4). LSP is not asked to re-answer it.

### 4.3 Request batching

- After `didOpen` for a file, the pass issues one `documentSymbol` request per file, awaited as a single round-trip.
- All hover / typeDefinition / implementation / definition requests for that file's call sites are fanned out with `Promise.all` under a concurrency cap of `lsp.servers.<lang>.concurrency` (default `8`).
- The pass MUST NOT batch across files. Each file goes `didOpen → drain requests → didClose` as a discrete unit. Rationale: per-file fallback (§6.1) needs a clear boundary, and per-file bounded memory keeps large monorepos tractable.

### 4.4 Timeouts

| Knob | Default | Rationale |
|---|---|---|
| `requestTimeoutMs` | `500` | Warm-cache hover on `typescript-language-server` measures under 50 ms; a 10× margin accommodates the first few files while a request queue is warming without letting pathological single requests block the file budget. |
| `fileBudgetMs` | `2000` | A p90 file with ~20 call sites × ~100 ms average round-trip on a cold cache ≈ 2 s. Beyond this the pass falls back per-file rather than waiting. |
| `initializeTimeoutMs` | `10000` | The `typescript-language-server` handshake on a medium monorepo commonly takes 3–7 s; 10 s absorbs cold-disk starts. |

These numeric defaults are empirical starting points. They live under `pluginOptions.<server>` compatibility scope ([`config.md`](./config.md) §14.1), so revising them is non-breaking.

## 5. What Gets Enriched

Viewed from the IR side, the pass writes to exactly the following fields. Nothing else is touched.

| IR field | Untyped-tier value | LSP-tier value | Confidence transition |
|---|---|---|---|
| `SourceRange.startColumn` / `endColumn` | `null` (hard-coded in the current TS extractor) | 1-based column from `documentSymbol` | no confidence field |
| `Call.resolved` for `this.*` / `super.*` | `null` | Symbol id when class hierarchy is resolvable | `null` → `high` (direct) or `medium` (walked hierarchy) |
| `Call.resolved` for interface-typed receivers | `null` | single implementer's Symbol id | `null` → `medium` |
| `Call.resolved` for otherwise-unresolved bare targets | `null` | Symbol id via `textDocument/definition` | `null` → `medium` |
| `CallEdge.confidence` for calls already resolved by the untyped tier | untyped-tier value ([`call-resolution.md`](./call-resolution.md) §7.2) | may be lifted per [`call-resolution.md`](./call-resolution.md) §7.2 | monotone upward only |
| `Signature.inferredThrows` (new optional field, §7.1) | absent from the JSON | array of throws inferred from called signatures' declared throws | recorded on the `Signature`; MUST NOT be merged into `Signature.throws` |

Invariants across the table:

- The pass MUST NOT overwrite an already non-`null` `Call.resolved`. This mirrors [`call-resolution.md`](./call-resolution.md) §5.4.
- The pass MUST NOT lower `CallEdge.confidence`.
- The pass MUST NOT emit fields not listed here.

## 6. Fallback Semantics

The pass degrades gracefully at three progressively larger granularities.

### 6.1 Fallback tiers

- **Per-request fallback**: a single LSP request errors or exceeds `requestTimeoutMs`. The specific enrichment for that request is skipped; the affected IR field retains its untyped-tier value. Sibling requests for the same file are unaffected.
- **Per-file fallback**: `didOpen` fails, or `fileBudgetMs` is exceeded for the file, or three consecutive requests hit per-request fallback. The pass sends `didClose`, marks the file `lsp-degraded` in stats, keeps every untyped-tier value in that file, and moves to the next file.
- **Per-language fallback**: `initialize` fails, or five consecutive files hit per-file fallback for the same language. The pass sends `shutdown` / `exit` to that language's server, disables LSP for that language for the remainder of the run, and emits one CLI warning.

### 6.2 IR degradation rules

Under any fallback:

- `SourceRange.startColumn` / `endColumn` remain `null`. Already schema-optional per [`ir-schema.md`](./ir-schema.md) §12.
- `Call.resolved` remains at whatever the untyped tier produced ([`call-resolution.md`](./call-resolution.md) §4). LSP fallback MUST NOT lower a resolved value back to `null`.
- `CallEdge.confidence` remains at the untyped tier's value.
- `Signature.inferredThrows` is **omitted entirely from the JSON** when this pass could not compute it. It is never emitted as an empty array to signal "we tried and found none".
- No error appears in the IR document itself; degradation is bookkept in `stats.lspEnrichment` (§7.2).

### 6.3 Numbered rules (RFC 2119)

1. Per-request fallback MUST NOT emit warnings. Rationale: warning per request would flood logs on large workspaces where transient timeouts are expected.
2. Per-file fallback MUST record `stats.lspEnrichment.filesFellBack += 1`.
3. Per-language fallback MUST append the language id to `stats.lspEnrichment.languagesDisabled[]` and MUST emit exactly one CLI warning.
4. Any fallback MUST NOT alter `Call.resolved` values set by the untyped tier.
5. Fallback state MUST NOT propagate across `aburi scan` invocations. Every scan starts with a clean per-language enablement.

## 7. Contract / Output Shape

### 7.1 Schema extensions (non-breaking per [`ir-schema.md`](./ir-schema.md) §15.2)

`SourceRange.startColumn` / `SourceRange.endColumn`: no schema change. Both fields already exist in `aburi.ir.v1.json` as optional `["integer", "null"]`. This pass simply populates them.

`Signature.inferredThrows: string[]`: a new optional field.

```jsonc
{
  "inputs": [{ "name": "amount", "type": "Money" }],
  "outputs": ["Invoice"],
  "throws": ["CreditLimitExceeded"],            // unchanged: explicit throws + @throws
  "inferredThrows": ["NetworkError"],           // NEW: appears only when LSP filled it
  "async": true,
  "generator": false,
  "typeParameters": []
}
```

**Critical property**: `inferredThrows` is deliberately excluded from the `api` fingerprint input (§8). It is a distinct field precisely so LSP-vs-no-LSP scans produce byte-identical `api` fingerprints.

### 7.2 Stats extension (non-fingerprinted)

```jsonc
{
  "stats": {
    "lspEnrichment": {
      "enabled": true,
      "filesEnriched": 412,
      "filesFellBack": 3,
      "requestsIssued": 5170,
      "requestsTimedOut": 12,
      "languagesDisabled": []
    }
  }
}
```

Stats live outside the fingerprint hash inputs ([`fingerprint.md`](./fingerprint.md) §3.1, §4.1, §5.1 — none of them list `stats.*`).

## 8. Interaction with Fingerprint / Diff

This is the load-bearing invariant of the whole pass. Enabling LSP MUST NOT change any fingerprint value.

- **`api` fingerprint** ([`fingerprint.md`](./fingerprint.md) §3.1) inputs `signature.inputs`, `signature.outputs`, `signature.throws`, `signature.typeParameters`, and other explicit-authoring signals. LSP MUST NOT write to any of these. `inferredThrows` is a distinct field precisely to preserve this.
- **`logic` fingerprint** ([`fingerprint.md`](./fingerprint.md) §4.1) inputs the rule sequence and the effect sequence. LSP adds neither rules nor effects (effect propagation is a separate pass that runs later). Unaffected.
- **`syntax` fingerprint** ([`fingerprint.md`](./fingerprint.md) §5.1) inputs the language plugin's normalized AST string. LSP never rewrites this. Unaffected.
- **`SourceRange.startColumn` / `endColumn`**: not present in any fingerprint input.
- **`Call.resolved` / `CallEdge.confidence`**: not present in `api` or `logic` fingerprint inputs. Effect propagation reads `CallEdge`, and the propagated effects it produces enter the `logic` fingerprint — but propagation is opt-in and its output is what enters the hash, not the `CallEdge` itself.

**Theorem (LSP fingerprint invariance)**. For any Symbol `S`, the byte content of `S.fingerprint.api`, `S.fingerprint.logic`, and `S.fingerprint.syntax` under `lsp.enabled: true` is byte-identical to the same fingerprints under `lsp.enabled: false`.

*Proof*. Enumerate the fields this pass writes (§5 and §7.1). None of them appear in any fingerprint input list ([`fingerprint.md`](./fingerprint.md) §3.1 / §4.1 / §5.1). No other pass reads LSP-enriched fields and mirrors them into fingerprint input. ∎

**Corollary**. `aburi diff` produces byte-identical `changed` / `unchanged` classifications regardless of whether either scan was run with LSP enabled. This is the mechanism that lets CI leave LSP off while a developer's local IDE turns it on, without diff-instability.

## 9. Diff Implications / Failure Modes

Diff stability follows from §8 corollary and is non-negotiable per [`overview.md`](./overview.md) §2.

What LSP-enabled diffs DO show differently:

- More `Call.resolved` values → richer Slice View clusters ([`slice-view.md`](./slice-view.md) §5.1) because more `CallEdge` entries survive the "unresolved calls contribute nothing" filter.
- Once effect propagation runs, more propagated effects because `CallEdge` coverage is higher.

Both are refinements of derived views over the IR — not shape changes to the IR itself.

Failure buckets (mirroring [`call-resolution.md`](./call-resolution.md) §8.1 style):

| Bucket | Meaning |
|---|---|
| `lsp-disabled` | `lsp.enabled: false`; no LSP attempt was made |
| `lsp-server-missing` | `command` did not resolve; per-language fallback fired at initialize |
| `lsp-initialize-timeout` | handshake exceeded `initializeTimeoutMs` |
| `lsp-file-budget-exceeded` | `fileBudgetMs` consumed before enrichment finished |
| `lsp-request-timeout` | a specific request exceeded `requestTimeoutMs` (per-request fallback fired) |
| `lsp-response-parse-error` | server returned malformed JSON-RPC; treated as per-file fallback |

Buckets are counted in `stats.lspEnrichment` (§7.2) and do not appear in the IR itself.

## 10. Determinism Guarantees

The pass is a pure function of `(SymbolCandidate[], lspConfig, serverResponses)`. Determinism is at least as strict as [`call-resolution.md`](./call-resolution.md) §9.

Concrete rules:

1. Every LSP response is captured in an in-memory cache keyed by `(file, line, column, requestKind)` **before** any IR field is written. This mirrors [`call-resolution.md`](./call-resolution.md) §5.5.
2. Ambiguity (multi-result `textDocument/implementation`, multi-result `textDocument/typeDefinition`) is resolved by lexicographic tiebreak on destination Symbol id. In the multi-implementer case for `textDocument/implementation`, the pass **does not** apply the tiebreak — it leaves `Call.resolved` at `null` (matches [`call-resolution.md`](./call-resolution.md) §5.3 semantics: pick a single implementer only when there is exactly one, unless a framework hook narrows the set).
3. Parallel LSP workers (from §4.3 concurrency) populate the cache in nondeterministic wall-clock order but the cache is consumed in a fixed order — Symbol id ascending, then call-site line ascending — when writing to `SymbolCandidate` records.
4. Cold-cache warm-up differences between runs are irrelevant because the pass does not use per-response timing as a signal.
5. Silent retries with exponential backoff are prohibited. A request either succeeds within `requestTimeoutMs` or triggers per-request fallback. Retry-on-load would make outcomes depend on machine load.
6. Fallback state (§6.1) is derived deterministically from the cache. Given identical `serverResponses`, identical files will fall back and identical files will succeed.

## 11. Verifiable Properties (Test Criteria)

### 11.1 Communication protocol — LE1..LE3

- LE1: `initialize` → `initialized` → open a fixture file → receive `documentSymbol` → columns populated on the IR for every Symbol in the fixture.
- LE2: Server `command` binary absent → per-language fallback fires at initialize, one CLI warning emitted, IR still produced from the untyped tier.
- LE3: Server process is `SIGKILL`ed mid-scan → per-language fallback fires on the next request, subsequent files use the untyped tier only.

### 11.2 Enrichment correctness — LE4..LE6

- LE4: `this.foo()` in class `C` with method `foo` in the same file → `Call.resolved = C.foo`'s Symbol id, `CallEdge.confidence = high`. Matches [`call-resolution.md`](./call-resolution.md) test CR16.
- LE5: interface-typed receiver with exactly one implementer → `Call.resolved` = implementer's method Symbol id, `CallEdge.confidence = medium`. Matches [`call-resolution.md`](./call-resolution.md) test CR19.
- LE6: file with no `this.*`, no interface-typed receivers, and all calls already resolved by the untyped tier → LSP pass is a no-op on every IR value in that file (only `SourceRange` columns change).

### 11.3 Fallback — LE7..LE8

- LE7: force per-request timeout for one specific call site's `hover` → that call site's `Call.resolved` stays at the untyped value; sibling call sites in the same file are unaffected; `stats.lspEnrichment.requestsTimedOut` increases by 1.
- LE8: file exceeds `fileBudgetMs` after half its call sites are enriched → the enriched half keeps LSP values, the unenriched half keeps untyped values, `stats.lspEnrichment.filesFellBack += 1`; the next file proceeds normally.

### 11.4 Fingerprint invariance (load-bearing) — LE9..LE10

- LE9: scan a fixture twice — once with `lsp.enabled: false`, once with `lsp.enabled: true` and a healthy server — and assert that `S.fingerprint.api`, `S.fingerprint.logic`, and `S.fingerprint.syntax` are byte-identical for every Symbol `S`.
- LE10: identical to LE9 but arrange per-file fallback for half the files (e.g. inject request errors for those files). Fingerprints MUST still be byte-identical.

### 11.5 Determinism — LE11..LE13

- LE11: reorder file processing (single-threaded vs concurrent workers) → byte-identical IR.
- LE12: language server returns implementers in reverse order between two runs → byte-identical `Call.resolved` values (tiebreak in §10.2).
- LE13: identical scan run twice back-to-back on the same fixture → byte-identical IR including `stats.lspEnrichment` counts.

## 12. Config Surface

### 12.1 Proposed JSON

```jsonc
{
  "lsp": {
    "enabled": false,
    "servers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "initializeTimeoutMs": 10000,
        "requestTimeoutMs": 500,
        "fileBudgetMs": 2000,
        "concurrency": 8,
        "initializationOptions": {}
      }
    }
  }
}
```

### 12.2 Field definitions

- `lsp.enabled` (bool, default `false`): master switch. `false` short-circuits the pass to a no-op regardless of `servers`.
- `lsp.servers.<language-id>` (object): one entry per language short-form id (`typescript`, `python`, `go`, …), keyed identically to the language-plugin id convention used in [`ir-schema.md`](./ir-schema.md) §3.
- `lsp.servers.<lang>.command` (string, required when the entry is present): absolute path or PATH-resolvable binary.
- `lsp.servers.<lang>.args` (string[], default `[]`).
- `lsp.servers.<lang>.initializeTimeoutMs` / `requestTimeoutMs` / `fileBudgetMs` / `concurrency`: the knobs specified in §4.3 / §4.4.
- `lsp.servers.<lang>.initializationOptions` (opaque object): forwarded verbatim to the server's `initialize` request; contents are server-specific and outside Aburi's compatibility scope ([`config.md`](./config.md) §5.4).

### 12.3 CLI override

`--lsp` / `--no-lsp` on `aburi scan` map to `lsp.enabled = true / false`, following [`config.md`](./config.md) §11 boolean-flag convention. All other knobs are config-file only.

### 12.4 Autodetect

`aburi init` autodetects a candidate `command` per configured language plugin by probing `PATH` (for TypeScript: `typescript-language-server`). Regardless of what it detects, the emitted config sets `lsp.enabled: false`. Users MUST flip the master switch consciously.

## 13. CI Stance

**Default off in CI. On-by-config in local development.**

Rationale: [`overview.md`](./overview.md) §2 rejects LSP-as-mandatory with "unstable in CI; large per-language variance". Making LSP opt-in preserves the tree-sitter tier as the CI-stable baseline. The `§8` fingerprint-invariance theorem is what keeps CI-off/dev-on mixing safe: the fingerprints do not diverge between environments, so `--fail-on` gates fire identically.

Requirements:

- `@aburi/github-action` MUST NOT set `lsp.enabled: true` by default. Users who opt in for a specific workflow accept the resulting flakiness budget explicitly.
- `aburi init` MUST NOT enable LSP even when it successfully autodetects a server binary (see §12.4).
- Documentation MUST describe the local-dev vs CI split.

## 14. Design Decisions

### 14.1 Why LSP enrichment lives in `@aburi/core`, not the language plugin

One LSP session serves many files across the whole run; a `LanguagePlugin` instance is a per-file abstraction ([`lang-plugin.md`](./lang-plugin.md) §3). Wiring the LSP client into every plugin would fragment session state. This mirrors [`call-resolution.md`](./call-resolution.md) §11.4's rationale for placing the resolver in `@aburi/core`.

### 14.2 Why `inferredThrows` is a distinct field from `throws`

Merging LSP-inferred throws into `Signature.throws` would make the `api` fingerprint depend on whether LSP was enabled ([`fingerprint.md`](./fingerprint.md) §3.1 hashes `signature.throws`). That breaks the §8 invariance theorem and therefore the CI-vs-local diff-stability guarantee. A separate, fingerprint-excluded field is the only structure that preserves invariance while still exposing the inferred information to consumers who want it (e.g. `aburi explain` output).

### 14.3 Why default-off, globally

LSP introduces a runtime dependency on an external process, its version, and its cache state. Reproducibility MUST NOT depend on such state. Off-by-default in every environment (CI and local) forces users to opt in per-machine, which surfaces the trade-off clearly. Local developers who want richer `aburi explain` output opt in; CI stays deterministic.

### 14.4 Why no `callHierarchy/*`

Tree-sitter's `walkBody` already produces the outgoing call list per Symbol ([`lang-plugin.md`](./lang-plugin.md) §4.4). Asking the server for the same edges would duplicate work, invite discrepancies (Aburi would have to reconcile two sources for the same fact), and vary widely across servers (Pyright, `typescript-language-server`, and `gopls` all have different call-hierarchy behaviors). Aburi keeps a single source of truth for call sites.

### 14.5 Why per-file boundaries for fallback

A single pathological file (large generated `.ts`, refactor-in-progress with malformed types, unresolved `d.ts` include chains) should not poison the whole run. A per-request cap alone would let a single bad file drain a total-scan budget. A per-file cap alone would penalize the whole file for one slow request. Two independent circuit breakers (per-request + per-file, with per-language as the last line of defense) contain damage at each granularity.

### 14.6 Why 500 ms / 2000 ms defaults

Empirically derived from `typescript-language-server` on medium monorepos: warm hover < 50 ms, p90 file ~2 s. The defaults trade some enrichment on cold starts (where request timeouts fire) for predictable file-level throughput. Because the knobs live under `pluginOptions.<server>` compatibility scope ([`config.md`](./config.md) §14.1), revising them is non-breaking.

### 14.7 Why `lsp.servers` is keyed by language short-form id

One LSP server per language, not per plugin manifest. A hypothetical `@aburi/lang-python-experimental` and `@aburi/lang-python` share the same Pyright process. Keying by the short-form language id (`typescript`, `python`, `go`) matches the same convention used for Symbol id language prefixes ([`ir-schema.md`](./ir-schema.md) §3), keeping mental overhead down.
