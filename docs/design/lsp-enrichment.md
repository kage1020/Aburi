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
- [`config.md`](./config.md) §5.4 — `pluginOptions` scope hosts opaque per-plugin options (used only for `initializationOptions` here, not for timeouts); §11 — CLI override convention followed by `--lsp` / `--no-lsp`; §14.1 — the Config Schema Compatibility Policy that timeout-default revisions live under

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

The pass lives in `@aburi/core`, not in a language plugin. A single LSP session serves many files across the run; a `LanguagePlugin`'s hook API operates one file at a time (every hook takes a single `SourceFile`, per [`lang-plugin.md`](./lang-plugin.md) §3), leaving no clean home for session state. This mirrors [`call-resolution.md`](./call-resolution.md) §11.4.

## 3. Inputs and Preconditions

| Input | Origin | Notes |
|---|---|---|
| `SymbolCandidate[]` | language plugin | one entry per Symbol; carries file, line ranges, target strings |
| `WorkspaceRoot` | `PluginContext.workspaceRoot` ([`lang-plugin.md`](./lang-plugin.md) §4.7) | absolute path passed to the server as `rootUri` |
| `lspConfig` | `Config.lsp` (§12) | server binary, timeouts, concurrency, opt-in flag |
| `languageServer` | spawned per language | one persistent stdio process per enabled language |

Preconditions:

1. LSP MUST be opt-in. `lsp.enabled` defaults to `false`. Rationale: [`overview.md`](./overview.md) §2 rejects LSP-as-mandatory for CI-stability reasons; opt-in enrichment inherits the same concern for its own tier only.
2. The pass is a no-op for any language that has no configured `lsp.servers.<lang>` entry (§12.1), regardless of `lsp.enabled`. Nothing on `LanguageCapabilities` ([`lang-plugin.md`](./lang-plugin.md) §6) governs LSP availability today; a language is "LSP-enrichable" purely by user configuration.
3. The server `command` MUST resolve on `PATH` or as an absolute path. If not, the pass triggers per-language fallback (§6.1).
4. Determinism MUST NOT depend on wall-clock server-response ordering; see §10.

## 4. LSP Communication Protocol Subset

### 4.1 Handshake

At scan start:

1. Spawn one server process per language for which `lsp.enabled` and `lsp.servers.<lang>` are both configured.
2. Send `initialize` with `rootUri = WorkspaceRoot`, `initializationOptions` from config (opaque, forwarded verbatim), and the client capability set `{ textDocument: { hover, typeDefinition, implementation, documentSymbol } }`.
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
| `textDocument/hover` on called symbol's declaration | declaration position of `foo` where a call site `foo()` was written | throws clauses in the declared signature | append to `Signature.inferredThrows` (§7.1) | n/a (`Signature.inferredThrows` is `string[]` with no per-entry confidence) |

Requests explicitly NOT used by this pass:

- `callHierarchy/incomingCalls` / `callHierarchy/outgoingCalls` — Tree-sitter already produces the call graph via `walkBody` ([`lang-plugin.md`](./lang-plugin.md) §4.4). Sourcing edges from LSP would duplicate the work and vary across servers. See §14.4.
- `textDocument/references` — reference resolution is the untyped tier's responsibility via `ImportEdge` ([`lang-plugin.md`](./lang-plugin.md) §4.4 / [`call-resolution.md`](./call-resolution.md) §4.4). LSP is not asked to re-answer it.
- `textDocument/definition` on otherwise-unresolved bare call targets — [`call-resolution.md`](./call-resolution.md) §5 defines exactly two LSP-tier resolution rules (§5.2 for `this`/`super`, §5.3 for interface-typed receivers). Neither covers a "last-resort go-to-definition" promotion of untyped bare targets. Adding that would require a new subsection in [`call-resolution.md`](./call-resolution.md) §5 and is out of scope for this document; the untyped tier's `null` is preserved.

### 4.3 Request batching

- After `didOpen` for a file, the pass issues one `documentSymbol` request per file, awaited as a single round-trip.
- All hover / typeDefinition / implementation requests for that file's call sites are fanned out with `Promise.all` under a concurrency cap of `lsp.servers.<lang>.concurrency` (default `8`).
- The pass MUST NOT batch across files. Each file goes `didOpen → drain requests → didClose` as a discrete unit. Rationale: per-file fallback (§6.1) needs a clear boundary, and per-file bounded memory keeps large monorepos tractable.

### 4.4 Timeouts

| Knob | Default | Rationale |
|---|---|---|
| `requestTimeoutMs` | `500` | Warm-cache hover on `typescript-language-server` measures under 50 ms; a 10× margin accommodates the first few files while a request queue is warming without letting pathological single requests block the file budget. |
| `fileBudgetMs` | `2000` | A p90 file with ~20 call sites × ~100 ms average round-trip on a cold cache ≈ 2 s. Beyond this the pass falls back per-file rather than waiting. |
| `initializeTimeoutMs` | `10000` | The `typescript-language-server` handshake on a medium monorepo commonly takes 3–7 s; 10 s absorbs cold-disk starts. |

These numeric defaults are empirical starting points, measured against `typescript-language-server` on a medium (~500-file) monorepo at design time. Actual performance shifts with server version, language version, and workspace shape, so the defaults are exposed as named `lsp.servers.<lang>.*` core config fields (§12.1) that can be tuned per project. Revising the defaults themselves is non-breaking under [`config.md`](./config.md) §14.1 (only removing or type-changing a field would be).

Notifications (`didOpen`, `didClose`, `initialized`, `exit`) are bounded by these same three knobs — the table above is the complete set, and there is deliberately no fourth knob for notifications. JSON-RPC treats a notification as fire-and-forget, but the *write* still awaits the transport, so a clogged stdio pipe stalls it exactly the way it stalls a request. An unbounded `didOpen` is the load-bearing case: it precedes the file's first request and therefore precedes every `fileBudgetMs` check, so the per-file budget below could never fire. The mapping:

- `didOpen` draws on `fileBudgetMs`. A notification that spends the whole budget has left nothing for the enrichment it exists to enable, so the budget is already the correct ceiling. Exceeding it is a per-file fallback (§6.1), the same as any other way of spending the budget.
- `didClose` draws on `requestTimeoutMs`. It is a single small write with no enrichment riding on it, and the sooner a stalled one gives up the sooner the next file starts. Its outcome cannot change what the file produced, so it is recorded but never escalated: a pipe stuck for good takes the next file's `didOpen` with it, and §6.1 escalation proceeds from there.
- `initialized` draws on `initializeTimeoutMs`. The handshake is not complete until it is on the wire, so a write that never lands is an `initialize` failure and takes the per-language fallback. It gets the full knob rather than what the `initialize` request left over — one operation, one budget, the same way `requestTimeoutMs` applies to each request individually.
- `exit` draws on the §4.1 1 s shutdown grace period. A stalled `exit` is ignored; the SIGKILL that follows is what actually guarantees the process goes away.

None of these are counted as requests in §7.2 — `requestsIssued` / `requestsTimedOut` / `requestsFailed` describe requests only. A `didOpen` that times out shows up as `filesFellBack`.

## 5. What Gets Enriched

Viewed from the IR side, the pass writes to exactly the following fields. Nothing else is touched.

| IR field | Untyped-tier value | LSP-tier value | Confidence transition |
|---|---|---|---|
| `SourceRange.startColumn` / `endColumn` | `null` (hard-coded in the current TS extractor) | 1-based column from `documentSymbol` | no confidence field |
| `Call.resolved` for `this.*` / `super.*` | `null` | Symbol id when class hierarchy is resolvable | `null` → `high` (direct) or `medium` (walked hierarchy) |
| `Call.resolved` for interface-typed receivers | `null` | single implementer's Symbol id | `null` → `medium` |
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
- **Per-file fallback**: `didOpen` fails — including a write that exceeds its §4.4 bound — or `fileBudgetMs` is exceeded for the file, or three consecutive requests hit per-request fallback. The pass sends `didClose`, marks the file `lsp-degraded` in stats, keeps every untyped-tier value in that file, and moves to the next file.
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

> **Status**: this section proposes schema extensions. `Signature.inferredThrows` is NOT yet present in `schema/aburi.ir.v1.json` or in `packages/types/src/generated/ir.ts`; landing it is tracked as a follow-up implementation issue. Only the `SourceRange` column population uses fields that already exist in schema today.

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

This pass writes to a strictly bounded set of IR fields (§5, §7.1). Whether enabling LSP changes any given fingerprint therefore reduces to: does the pass write to a field that enters that fingerprint's hash input, either directly, or indirectly through a downstream pass?

- **`api` fingerprint** ([`fingerprint.md`](./fingerprint.md) §3.1) inputs `signature.inputs`, `signature.outputs`, `signature.throws`, `signature.typeParameters`, and other explicit-authoring signals. LSP MUST NOT write to any of these. `inferredThrows` is a distinct field precisely to preserve this. No downstream pass reads LSP output and mirrors it into `api` input.
- **`syntax` fingerprint** ([`fingerprint.md`](./fingerprint.md) §5.1) inputs the language plugin's normalized AST string. LSP never rewrites this, and no downstream pass mirrors LSP output into it.
- **`logic` fingerprint** ([`fingerprint.md`](./fingerprint.md) §4.1) inputs the rule sequence and the effect sequence. **LSP output can change this indirectly.** LSP lifts `CallEdge` coverage; effect propagation reads `CallEdge[]` and, per [`effect-propagation.md`](./effect-propagation.md) §8, propagated effects are appended to `Symbol.effects[]` and enter the `logic` fingerprint's serialization. A caller in the transitive closure of a symbol that gained a `db.write` will therefore have a different `logic` fingerprint under `lsp.enabled: true` (if the LSP tier resolved an additional edge into that closure) than under `lsp.enabled: false`. This is the deliberate behavior of the propagation pass — [`effect-propagation.md`](./effect-propagation.md) §8 rejects "exclude propagated effects from `logic` fingerprint input" explicitly, because that would blind the reviewer to the signal the pass exists to surface. See §14.8 for why we do not fight this.

**Theorem (partial LSP fingerprint invariance)**. For any Symbol `S`, `S.fingerprint.api` and `S.fingerprint.syntax` are byte-identical under `lsp.enabled: true` and `lsp.enabled: false`.

*Proof*. Enumerate the fields this pass writes (§5 and §7.1): `SourceRange.startColumn` / `endColumn`, `Call.resolved`, `CallEdge.confidence`, `Signature.inferredThrows`. None appear in the `api` or `syntax` fingerprint input list ([`fingerprint.md`](./fingerprint.md) §3.1 / §5.1). No downstream pass reads any of these fields and writes into `api` or `syntax` inputs. ∎

**Non-theorem**. `S.fingerprint.logic` is **not** guaranteed byte-identical across LSP-on and LSP-off scans of the same source tree. Cases where it differs:

- The untyped tier left `Call.resolved: null` for a call whose actual callee has a `db.write` (or any classified effect) in its transitive downstream. LSP lifts the resolution, effect propagation runs, and the caller's `Symbol.effects[]` gains a propagated entry.
- Symmetric: LSP lifts a resolution that adds a propagated effect to some caller, then in a later scan LSP is disabled and the resolution reverts to `null` — that caller's `effects[]` loses the propagated entry.

Where `logic` **is** guaranteed byte-identical:

- Callees whose transitive out-closure contains no classified effects (their propagated `effects[]` is empty in both modes).
- Symbols outside the transitive caller closure of any LSP-newly-resolved edge (locality per [`effect-propagation.md`](./effect-propagation.md) §10).

**Corollary — diff stability requires a stable LSP configuration**. Two `aburi scan` invocations compared by `aburi diff` MUST run with matching `lsp.enabled` and matching per-language server availability if the resulting `changed` / `unchanged` classifications are to reflect source changes only, not enablement changes. In practice this means: choose one setting for the project (on or off) and use it uniformly across every environment that produces IR intended for time-series comparison. See §13.

## 9. Diff Implications / Failure Modes

`aburi diff` is stable under LSP configuration only when both `aburi scan` runs used matching `lsp.enabled` and matching effective per-language server availability (§8 Corollary). The `overview.md` §2 "diff stability" mandate is honored in that regime.

What an LSP-enabled scan produces differently from an LSP-off scan of the same source tree:

- More `Call.resolved` values → richer Slice View clusters ([`slice-view.md`](./slice-view.md) §5.1) because more `CallEdge` entries survive the "unresolved calls contribute nothing" filter.
- More propagated effects on the transitive callers of any Symbol whose new resolution reached into a classified-effect closure ([`effect-propagation.md`](./effect-propagation.md) §8), and hence a different `Symbol.fingerprint.logic` for those callers.

Neither is a change to the IR schema; both are legitimate refinements of the IR's derived views and are the intended payoff of running LSP. What they mean operationally is that flipping `lsp.enabled` between two scans that are then compared **will** produce spurious `logic changed` entries on affected callers. Users who need CI-vs-local mixed configurations must accept that or run both scans with the same setting (§13).

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

### 11.3 Fallback — LE7..LE8, LE19..LE21

- LE7: force per-request timeout for one specific call site's `hover` → that call site's `Call.resolved` stays at the untyped value; sibling call sites in the same file are unaffected; `stats.lspEnrichment.requestsTimedOut` increases by 1.
- LE8: file exceeds `fileBudgetMs` after half its call sites are enriched → the enriched half keeps LSP values, the unenriched half keeps untyped values, `stats.lspEnrichment.filesFellBack += 1`; the next file proceeds normally.
- LE19 (notification writes are bounded): a transport whose notification write never settles → `didOpen` and `didClose` return within their §4.4 bounds rather than parking the pass, `initialize` returns a failure when `initialized` cannot be written, and `shutdown` still reaches SIGKILL when `exit` cannot be written.
- LE20 (a stalled `didOpen` is a per-file fallback): the `didOpen` write for one file exceeds `fileBudgetMs` → that file counts in `filesFellBack`, no request is issued against it, `didClose` is still sent, and the next file is enriched normally. Holds both when the write fails and when it merely returns having spent the budget.
- LE21 (a stalled `didClose` is not): the `didClose` write for an otherwise healthy file fails → the file still counts in `filesEnriched`, `filesFellBack` does not increase, and no IR value changes.

### 11.4 Partial fingerprint invariance (load-bearing) — LE9..LE12

- LE9: scan a fixture twice — once with `lsp.enabled: false`, once with `lsp.enabled: true` and a healthy server — and assert that `S.fingerprint.api` and `S.fingerprint.syntax` are byte-identical for every Symbol `S`. `S.fingerprint.logic` is NOT asserted equal — see LE11 for its behavior.
- LE10: identical to LE9 but arrange per-file fallback for half the files (e.g. inject request errors). `api` and `syntax` fingerprints MUST still be byte-identical.
- LE11: same LSP-off vs LSP-on comparison as LE9, but the fixture contains at least one call where the untyped tier leaves `Call.resolved: null` and whose actual callee has a `db.write` in its transitive downstream. The transitive callers of that callee MUST have a different `logic` fingerprint between the two runs (matching [`effect-propagation.md`](./effect-propagation.md) §11.1 "propagation is monotone in resolved edges"). Symbols outside that transitive closure MUST have byte-identical `logic` fingerprints.
- LE12: LSP-off vs LSP-on comparison of `signature.throws` — MUST be byte-identical for every Symbol (LSP-inferred throws land in `signature.inferredThrows`, never in `signature.throws`; guards §14.2).

### 11.5 Determinism — LE13..LE15

- LE13: reorder file processing (single-threaded vs concurrent workers) → byte-identical IR.
- LE14: language server returns implementers in reverse order between two runs → byte-identical `Call.resolved` values (tiebreak in §10.2).
- LE15: identical scan run twice back-to-back on the same fixture → byte-identical IR including `stats.lspEnrichment` counts.

### 11.6 Behavioral guards — LE16..LE18

- LE16 (`CallEdge.confidence` monotone): for any Symbol whose LSP-off `CallEdge.confidence` for a given edge is `C_untyped`, the LSP-on value `C_lsp` MUST satisfy `C_lsp ≥ C_untyped` on the `high > medium > low` lattice. The pass MUST NEVER lower a confidence.
- LE17 (`inferredThrows` omit-vs-empty): for a Symbol whose LSP `hover` on called declarations returned no throws (either no calls declared throws, or LSP fell back), the emitted `Signature` JSON MUST NOT contain an `inferredThrows` key at all (per §6.2 / §7.1). Assert with a JSON-key existence check, not an array-length check.
- LE18 (no silent retry): inject a request that fails with a transient error at time `t` and succeeds at time `t + Δ`. The pass MUST NOT reissue that request within the same scan; the field stays at the untyped-tier value and `stats.lspEnrichment.requestsTimedOut` (or the appropriate bucket) increments by 1.

## 12. Config Surface

### 12.1 Proposed JSON

> **Status**: this section proposes new config schema. The `lsp` object is NOT yet present in `schema/aburi.config.v1.json` or documented in [`config.md`](./config.md); landing it is tracked as a follow-up implementation issue.

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

**Default off. Uniform across every environment that produces IR intended for time-series comparison.**

Rationale is two-layered:

1. [`overview.md`](./overview.md) §2 rejects LSP-as-mandatory with "unstable in CI; large per-language variance". Making the pass opt-in preserves the tree-sitter tier as the CI-stable baseline. Off-by-default respects that.
2. §8 established that `logic` fingerprint is not invariant under `lsp.enabled` toggles. Consequently, mixing `lsp.enabled: true` in one environment with `lsp.enabled: false` in another will produce spurious `changed` entries in `aburi diff` for callers in any LSP-newly-resolved effect closure. A project MUST pick one setting (on or off) and apply it uniformly to every scan whose IR feeds a time-series comparison, or else accept those spurious diffs as noise.

Requirements:

- `@aburi/github-action` MUST NOT set `lsp.enabled: true` by default. A project that opts in for a workflow MUST also opt in for every developer-machine scan whose output is compared against CI's, or accept diff noise.
- `aburi init` MUST NOT enable LSP even when it successfully autodetects a server binary (§12.4).
- Documentation MUST warn that mixed configurations across environments produce non-source-driven `logic changed` entries.

The `api` and `syntax` fingerprints ARE byte-stable across LSP configurations (§8 Theorem). CI gates keyed only on `--fail-on` categories that read `api` or `syntax` deltas (e.g., "any api-breaking change") therefore fire identically regardless of LSP setting. Gates keyed on `logic` deltas do not.

## 14. Design Decisions

### 14.1 Why LSP enrichment lives in `@aburi/core`, not the language plugin

One LSP session serves many files across the whole run; a `LanguagePlugin`'s hook API operates one file at a time (every hook takes a single `SourceFile`, per [`lang-plugin.md`](./lang-plugin.md) §3). Session state — the initialized server, the open-file set, the request cache — has no clean home inside a per-file hook. Placing the pass in `@aburi/core` mirrors [`call-resolution.md`](./call-resolution.md) §11.4's rationale for the resolver.

### 14.2 Why `inferredThrows` is a distinct field from `throws`

Merging LSP-inferred throws into `Signature.throws` would make the `api` fingerprint depend on whether LSP was enabled ([`fingerprint.md`](./fingerprint.md) §3.1 hashes `signature.throws`). That is the one fingerprint layer we CAN keep byte-stable under LSP toggles (§8 Theorem), and mixing inferred and explicit throws into a single hashed field would forfeit it. A separate, non-hashed field preserves the `api` invariance we have — the one gate consumers rely on to say "no API-breaking change here" without regard to LSP configuration — while still exposing inferred information to `aburi explain` and other read-side consumers.

### 14.3 Why default-off, globally

LSP introduces a runtime dependency on an external process, its version, and its cache state. Reproducibility MUST NOT depend on such state. Off-by-default in every environment (CI and local) forces users to opt in per-machine, which surfaces the trade-off clearly. Local developers who want richer `aburi explain` output opt in; CI stays deterministic.

### 14.4 Why no `callHierarchy/*`

Tree-sitter's `walkBody` already produces the outgoing call list per Symbol ([`lang-plugin.md`](./lang-plugin.md) §4.4). Asking the server for the same edges would duplicate work, invite discrepancies (Aburi would have to reconcile two sources for the same fact), and vary widely across servers (Pyright, `typescript-language-server`, and `gopls` all have different call-hierarchy behaviors). Aburi keeps a single source of truth for call sites.

### 14.5 Why per-file boundaries for fallback

A single pathological file (large generated `.ts`, refactor-in-progress with malformed types, unresolved `d.ts` include chains) should not poison the whole run. A per-request cap alone would let a single bad file drain a total-scan budget. A per-file cap alone would penalize the whole file for one slow request. Two independent circuit breakers (per-request + per-file, with per-language as the last line of defense) contain damage at each granularity.

### 14.6 Why 500 ms / 2000 ms defaults

Empirically derived from `typescript-language-server` on medium monorepos: warm hover < 50 ms, p90 file ~2 s (§4.4). The defaults trade some enrichment on cold starts (where request timeouts fire) for predictable file-level throughput. The knobs are named `lsp.servers.<lang>.*` core fields (§12.1), not `pluginOptions` — timeouts are not server-specific opaque configuration, they are Aburi-level circuit-breaker settings — but they are still user-tunable per project, and revising the defaults themselves is non-breaking under [`config.md`](./config.md) §14.1.

### 14.7 Why `lsp.servers` is keyed by language short-form id

One LSP server per language, not per plugin manifest. A hypothetical `@aburi/lang-python-experimental` and `@aburi/lang-python` share the same Pyright process. Keying by the short-form language id (`typescript`, `python`, `go`) matches the same convention used for Symbol id language prefixes ([`ir-schema.md`](./ir-schema.md) §3), keeping mental overhead down.

### 14.8 Why we do not fight `logic` fingerprint non-invariance

We could have introduced a "propagated-from-LSP-only" bit on each `Symbol.effects[]` entry and excluded such entries from the `logic` fingerprint. That would restore full LSP invariance at the cost of hiding real callee-effect changes from the reviewer whenever the resolution that surfaced them happened to require LSP. The pass exists to enrich the graph; the propagation pass exists to surface effect changes along the enriched graph; excluding LSP-derived enrichments from the fingerprint would defeat both. [`effect-propagation.md`](./effect-propagation.md) §8 makes the parallel argument for propagated effects generally. We accept the constraint (§13: use a uniform LSP setting for time-series comparison) as the honest price of the signal.
