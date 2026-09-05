# Call Resolution

Specification of how Aburi resolves the identity of a callee at a call site — turning the raw callee string in `Symbol.calls[].target` into a workspace-relative Symbol id in `Symbol.calls[].resolved`.

References:
- [`ir-schema.md`](./ir-schema.md) §10 — the shape of `Call` and the `resolved` field
- [`lang-plugin.md`](./lang-plugin.md) §2.2, §4.4 — the Language Plugin's boundary (call resolution is out of scope) and the `CallCandidate` shape
- [`effect-plugin.md`](./effect-plugin.md) — how effect classification takes precedence over resolution
- [`effect-propagation.md`](./effect-propagation.md) — the consumer that propagates effects along resolved edges
- [`slice-view.md`](./slice-view.md) — the consumer that clusters over the resolved call graph
- [`lsp-enrichment.md`](./lsp-enrichment.md) — the optional layer that refines resolution outcomes

---

## 1. Purpose

`Symbol.calls[].target` is a normalized callee string produced by the language plugin (e.g. `pricing.calculateTotal`, `this.repo.save`, `handler`). It is a **string**, not a reference. Effect propagation and Slice View both need edges over the **Symbol universe** — that is, `<language>:<file>#<qname>` ids on both endpoints.

Call resolution is the pass that fills in `Symbol.calls[].resolved` with the id of the callee Symbol, or leaves it `null` when identity cannot be established with sufficient confidence.

The pass runs in the core (`@aburi/core`). The language plugin does not do resolution ([`lang-plugin.md`](./lang-plugin.md) §2.2 — "Call resolution (filling in `calls[].resolved`)" is out of scope).

## 2. Two-Tier Resolution Model

Aburi runs in two environments:

| Tier | Availability | Refines |
|---|---|---|
| **Untyped (default)** | always | resolves by import binding + qualified-name matching over the Symbol table |
| **LSP-enriched (optional)** | when a language server is running and available (spec: [`lsp-enrichment.md`](./lsp-enrichment.md)) | resolves method dispatch through the actual receiver type + interface implementations |

The two tiers share a **single output contract** (§7). Enabling LSP MUST NOT change the shape or ordering of `calls[]`; it only lifts more `resolved: null` entries to non-null and lifts `confidence`. This preserves time-series diff stability (`overview.md` §2 — "diff stability" is non-negotiable).

Every implementation of a language plugin's call-resolution helpers must therefore expose the two tiers as one function whose *inputs* differ but whose *output types* are identical.

## 3. Inputs to the Resolver

The resolver runs after all files have been parsed and `Symbol[]` is available. Its inputs are:

| Input | Origin | Notes |
|---|---|---|
| `symbolTable` | `@aburi/core` | index of every Symbol keyed by id and by `(file, qname)` |
| `symbolCandidate` | `@aburi/lang-typescript` (`extractSymbols`) | the caller — provides `id` and `SourceRange.file` |
| `Symbol.component` | `@aburi/core` (`runFilePipeline`) | the caller's Component, which §4.5 scopes its search to. Not a language-plugin field: `SymbolCandidate` has none, and the core writes it from the file's path against `Component.roots[]` ([`component-detect.md`](./component-detect.md) §12) |
| `call` | `walkBody` `CallCandidate` | provides `target`, `line`, `argumentCount`, `inAwait`, `inNew`, `literalArgs` |
| `importTable` | `parseFile().imports` | per-file `ImportEdge[]` (`lang-plugin.md` §4.2) — the resolver reads this to know what a bare identifier binds to |
| `localScope` | derived per Symbol | in-file local declarations shadowing imports / module-level names |
| `receiverTypes` | LSP layer only | actual type at each call receiver — absent in the untyped tier |

The **caller's file path** is the anchor; resolution is always evaluated in the frame of one call site inside one Symbol.

## 4. Untyped Resolution Rules

The untyped tier resolves callees by **name binding**, not by type. It runs five ordered steps; the first step to return a match wins.

### 4.1 Step order

```
1. Local scope   — a variable or nested function in the caller's Symbol matches the leading identifier
2. File scope    — a top-level Symbol in the same file matches the leading identifier
3. Import scope  — the leading identifier is bound by an import at the top of the file
4. Component scope — cross-file match within the same component (§4.5)
5. Workspace scope — cross-component match against a globally-unique qname (§4.6)
```

Steps 1–3 handle same-file / directly-imported calls. Steps 4–5 catch cases where the language plugin's normalized `target` already includes enough qualification to disambiguate (e.g. `PricingService.calculateTotal`) but the receiver has no explicit import in the caller's file.

### 4.2 Step 1: local scope

For `target` of the form `name` or `name.<rest>`, if `name` is a parameter, local variable, or nested function declared in the caller Symbol's body, the call is **unresolvable** (the receiver is a runtime value, not a source Symbol) and `resolved` stays `null`. Confidence of this determination is `high` — a local shadow is textual and unambiguous.

Rationale: promoting a locally-scoped identifier to a Symbol id would produce false edges. Emitting `null` here is a **correct** resolution, not a failure.

### 4.3 Step 2: file scope

If `name` matches a top-level `Symbol.name` in the same file (Symbol id → `<lang>:<caller.file>#<name>`), emit `resolved = that Symbol.id` with `confidence = high`.

For dotted targets (`name.method`), the file-scope match is against `name` first; if `name` resolves to a class-shaped Symbol in the same file, `resolved` is set to `<lang>:<caller.file>#<name>.method` when that method Symbol exists. If the method Symbol is absent (dynamic method, method inherited from a base class, etc.), `resolved` stays `null` (do not fabricate ids for methods that never appear in the Symbol table).

### 4.4 Step 3: import scope

Read `importTable[caller.file]`. If `name` appears in an `ImportEdge.symbols` (named import) or matches an `import * as name` alias, resolve `name` to the imported source module.

Sub-cases:

| Import shape | Resolution |
|---|---|
| `import { X } from './y'` | `name = X` → resolve to `<lang>:<resolved-file>#X` |
| `import { X as Alias } from './y'` | `name = Alias` → resolve to `<lang>:<resolved-file>#X` (original name) |
| `import * as ns from './y'` | `name = ns` and `target = ns.foo` → resolve to `<lang>:<resolved-file>#foo` |
| `import Default from './y'` | `name = Default` → resolve to `<lang>:<resolved-file>#<default>` |
| `import type { X } from './y'` | ignored (type-only imports produce no runtime edge) |
| `import('./y')` (dynamic) | ignored at the target site; recorded as a `via: import` component edge only |
| bare specifier `'lodash'` | out-of-workspace — `resolved` stays `null`, confidence `high` (this is a definite external, not a failure) |

Resolving `./y` to a Symbol file requires the file-path normalizer defined in §4.4.1.

#### 4.4.1 Import specifier resolution

For a specifier `'./y'` (or `'../y'`, `'@workspace-alias/foo'`) in file `apps/billing/src/svc/InvoiceService.ts`:

1. **Relative** (`.`/`..` prefix) — resolve against the caller's file directory.
2. **Path alias** — apply the mapping table read from the language plugin's config at startup:
   - For TypeScript: the `paths` field of the caller's nearest `tsconfig.json` (Node16/NodeNext resolution semantics), plus each workspace package name declared in `pnpm-workspace.yaml` / `workspaces` / `turbo.json`.
   - For other languages: the equivalent lookup surface the plugin declares (out of scope here).
3. **Extension probing** — try extensions in the order declared by the language plugin (`fileExtensions`, [`lang-plugin.md`](./lang-plugin.md) §4.1). For a directory target, append `/index.<ext>` and probe again.
4. **Symbol table hit** — confirm the resolved absolute path (workspace-relativized to POSIX) exists as a Symbol id prefix in `symbolTable`. If not, `resolved` stays `null`, `confidence` = `high` (a definite miss).

The mapping table is built once per `aburi scan` invocation from the config already loaded by [`config.md`](./config.md) and the workspace-manager information already produced by [`component-detect.md`](./component-detect.md) §3; the resolver reads it, never re-parses `tsconfig.json` or workspace manifests. Determinism follows: no filesystem race can influence which candidate wins because the candidate order is fixed by the language plugin's `fileExtensions` list and the mapping table is deterministic input.

### 4.5 Step 4: component scope

If steps 1–3 did not produce a match but `target` is a **qualified name** (`ClassName.method` or `Namespace.ClassName.method`), search `symbolTable` for a Symbol whose `name` equals `target` and whose `component` equals the caller's `component`.

- **Unique match** → `resolved` = that Symbol.id, `confidence = medium`. The identifier is unambiguous within the boundary but there was no explicit import — this is either a legitimate cross-file same-component call (e.g. re-exported via a barrel) or an inheritance-style reference.
- **Multiple matches** → do not resolve. `resolved` stays `null`, `confidence = medium` (ambiguity is real). Record the candidates for reporting (§8).
- **No match** → fall through to Step 5.

### 4.6 Step 5: workspace scope

Same as Step 4 but the search is over the whole workspace, not just the caller's component.

- **Unique match** → `resolved` = that Symbol.id, `confidence = low`. A globally-unique qname is weak evidence; consumers should treat these edges as suggestive rather than authoritative.
- **Multiple matches** → do not resolve. `resolved` stays `null`.
- **No match** → `resolved` stays `null`, `confidence = high` for the negative result (the callee is genuinely external or a runtime value).

### 4.7 Special normalized targets

The language plugin's `normalizeCallee` produces some targets that never resolve to a Symbol and MUST be left unresolved:

| Target shape | Reason |
|---|---|
| `this.<method>` | `this` is a runtime value; resolving it requires typed dispatch (LSP tier) |
| `super.<method>` | Same — requires the parent class chain |
| `new <ClassName>()` receiver in a chain | `new` produces an instance; only the class is resolvable, method dispatch off it is not |
| method chains on non-identifier receivers (`getRepo().save`) | receiver is an expression result, not a name |

For `this` and `super`, the untyped tier writes `null` with `confidence = medium`; the LSP tier can promote these to real ids (§5.2).

## 5. LSP-Enriched Resolution Rules

When LSP is available, resolution runs a second pass that reads receiver types.

### 5.1 Additional inputs

- `receiverType(callSite)` — the resolved type of the receiver expression at the call site (returned from the language server's `textDocument/hover` or `typeDefinition` request).
- `implementers(interfaceName)` — the set of Symbols known to `implements`/`extends` the given interface (from `textDocument/implementation`).

The exact protocol subset used, plus fallback and timeout policy, is specified in [`lsp-enrichment.md`](./lsp-enrichment.md) §4. This document only names the two capabilities and treats them as inputs.

### 5.2 Method dispatch through `this` / `super`

For `this.<method>` in a caller Symbol whose parent class C is known:
- Resolve to `<lang>:<file>#C.<method>` when that Symbol exists.
- If C is a subclass, walk the class hierarchy via `implementers`; the nearest ancestor that declares `<method>` wins.
- `confidence = high` when the resolution is direct on C, `medium` when it required walking the hierarchy.

For `super.<method>`: same but starting one level up the class hierarchy.

A hint arriving from the enrichment pass is keyed by `file:line` and carries the receiver it was measured for, and the resolver applies it only to a call site that writes that same receiver. One line can hold both — `this.foo(super.foo())` is one line and two call sites — and the key they share holds one hint, so without the check the call that lost the key would take a `high`-confidence edge to a method no hover ever attributed to it. The declined call falls through to §8.1 like any other miss and is counted in `stats.lspEnrichment.hintsRejected.kindMismatch` ([`lsp-enrichment.md`](./lsp-enrichment.md) §7.2).

### 5.3 Interface-typed receivers

For `repo.save(...)` where `repo`'s LSP type is `IRepository`:
- Look up `implementers(IRepository)` — the set of implementing classes.
- If it is a **single class**, `resolved` = that class's `.save` Symbol, `confidence = medium`.
- If it is **multiple classes** and DI wiring is knowable via the framework plugin (`framework:nestjs:provider` binding), the framework plugin may supply the chosen implementer via a hook (§7.4); use its answer with `confidence = medium`.
- If ambiguous, `resolved` stays `null` — do not silently pick one.

### 5.4 Untyped result preservation

If the untyped tier already resolved a call, the LSP tier does not overwrite it — the untyped result is authoritative for cases the type layer cannot see (barrel re-exports pointing at a different declaration file, for instance). The LSP tier only touches entries where the untyped tier left `resolved: null`.

Exception: if the untyped tier resolved to a Symbol id that no longer exists in `symbolTable` (deleted between passes — should not happen, but defensively), the LSP tier may replace it.

### 5.5 Determinism of LSP results

Language server responses can be non-deterministic across runs (server startup order, cache state, order in which files were indexed). To keep the IR deterministic:
- The resolver reads all needed LSP data into an in-memory cache **before** emitting resolutions.
- Cache lookup is by `(file, line, column)` — never by wall-clock ordering.
- Ambiguous LSP answers (e.g. multiple candidates for `typeDefinition`) are resolved with a canonical tiebreak (lexicographic on Symbol id) so the same input produces the same output regardless of server response order.

## 6. Dynamic Dispatch and Higher-Order Calls

Some call shapes cannot be resolved statically — with or without LSP. The specification is explicit about which shapes are left `null` **by design**.

| Shape | Behavior | Confidence |
|---|---|---|
| `callback(...)` where `callback` is a parameter | `null` | `high` (a parameter is genuinely runtime data) |
| `map[key](...)` — dispatched via computed key | `null` | `high` |
| `factory().method(...)` — receiver is an expression | `null` (untyped); LSP may resolve when return type is a concrete class | `medium` / `high` |
| `arr.map(fn)` where `fn` is a locally-declared function passed by reference | The **outer** call (`arr.map`) is resolved as usual; the **passed** `fn` produces no edge from the caller Symbol (the reference itself is not a call). If `fn` is invoked later inside `arr.map`, that invocation lives in the library's implementation, not in workspace source. | n/a |
| `await Promise.all([fn1(), fn2()])` | Each element `fn1()` / `fn2()` is a normal call and is resolved separately. `Promise.all` itself resolves to the external global. | as usual |
| decorator invocation (`@Post('/x')`) | Not a call from `walkBody`'s point of view — decorators live in `Symbol.decorators[]`, not `Symbol.calls[]`. Framework plugins handle them separately. | n/a |

Rule of thumb: **when the receiver is not a name, we do not fabricate a name for it**. A `null` `resolved` with an explicit reason is more useful downstream than a plausible but wrong id.

## 7. Contract with `@aburi/core` Symbol Graph

The Symbol call graph is built by projecting the resolved `calls[]` into edges.

### 7.1 Edge shape

```
CallEdge {
  from: SymbolId          // caller symbol id
  to:   SymbolId          // callee symbol id (never null)
  via:  "call"            // matches Dependency.via enum in ir-schema §11.1
  confidence: Confidence  // same enum as Symbol; the resolution confidence
  line: number            // caller site (from Call.line)
}
```

A call with `resolved: null` produces **no edge** — the graph is built only from resolved calls. Effect propagation ([`effect-propagation.md`](./effect-propagation.md)) and Slice View ([`slice-view.md`](./slice-view.md)) consume `CallEdge[]` and do not need to inspect `resolved: null` entries themselves.

### 7.2 Confidence propagation

The edge's `confidence` is the resolution confidence at the moment of resolution:

| Resolution path | Edge confidence |
|---|---|
| §4.3 file scope | `high` |
| §4.4 import scope | `high` |
| §4.5 component scope (unique) | `medium` |
| §4.6 workspace scope (unique) | `low` |
| §5.2 LSP `this`/`super` direct | `high` |
| §5.2 LSP walked hierarchy | `medium` |
| §5.3 LSP interface with single impl | `medium` |
| §5.3 LSP interface with DI-resolved impl | `medium` |

Effect propagation must respect edge confidence when combining propagated effect confidence — see [`effect-propagation.md`](./effect-propagation.md) §5.3.

### 7.3 Cross-language edges

An edge whose `from` and `to` differ in the `<language>:` prefix is a **cross-language call**. The untyped tier of this document does not resolve cross-language calls; they are the concern of `multi-language-id.md` (Later phase). Until that design lands, the resolver emits `null` for any candidate whose only match crosses language boundaries.

### 7.4 Framework-plugin hook (optional)

For §5.3, framework plugins may register a `resolveDispatch(interfaceName, callerComponent) → SymbolId | null` hook. When registered:
- The core queries plugins in config order; first non-null wins (same convention as effect plugins per [`effect-plugin.md`](./effect-plugin.md) §5.1).
- Absent any registration, §5.3's ambiguity rule applies (single impl auto-resolves; multiple leaves `null`).

This hook is the seam through which NestJS provider wiring / React Context providers / Angular DI can turn interface-typed calls into concrete edges without hardcoding DI knowledge into the core.

## 8. Failure Modes and Reporting

Every unresolved call is a **first-class outcome**, not a warning. Consumers must never assume `resolved != null`.

### 8.1 Classification of `resolved: null`

The core does not persist a "why null" reason field on `Call` in the IR. Adding an optional field is non-breaking under [`ir-schema.md`](./ir-schema.md) §15.2, so this is a design choice, not a compatibility constraint: diagnostic buckets are per-run debugging output and belong in logs, not in the fingerprinted IR (they would enlarge every IR document for review value that only matters when investigating a specific resolution outcome). The resolver emits a per-run diagnostic log with buckets:

| Bucket | Meaning | Example |
|---|---|---|
| `local-scope` | resolved to a local variable / parameter | `callback(x)` inside `foo(callback: () => void)` |
| `external` | resolved to a bare specifier import | `lodash.sortBy(...)` |
| `dynamic` | receiver is an expression, not a name | `getRepo().save(...)` |
| `ambiguous` | multiple candidates | two `User.save` in different components with no explicit import |
| `no-match` | no candidate found | typo, or callee not in workspace and not imported |

#### Bucket precedence

A single call can fit several descriptions at once — a parameter that happens to share a name with an imported package, an ambiguous qname reached through an expression receiver. The reviewer needs one stable answer per call site, so the resolver assigns the **most specific cause** in this fixed order:

1. `local-scope` — the §4.2 shadow guard fired, so the resolver never looked outward at all.
2. `dynamic` — the receiver is not a name: an expression receiver reported by the language plugin, or `this` / `super` with no LSP hint (§4.7). `this.save()` is filed here because in the untyped tier the receiver's identity is a runtime property of the class hierarchy, exactly like `getRepo().save()`; there is no name for the resolver to look up.
3. `ambiguous` — some tier found the callee and refused to choose between candidates (§7.1). The competing Symbol ids are recorded, deduplicated and lex-sorted.
4. `external` — the head of the target is bound in the caller's file by an import whose specifier is not relative. §4.4.1 resolves relative specifiers only, so such a callee is out of reach by construction rather than by accident.
5. `no-match` — nothing matched anywhere.

The order is part of the contract: changing it would move counts between buckets on an unchanged workspace.

#### Where the counts and the detail live

Aggregate counts go to `IR.stats.callResolution` ([`ir-schema.md`](./ir-schema.md) §12), an optional object added additively under §15.2:

```jsonc
"callResolution": {
  "totalCalls": 1310,     // call sites in Symbol.calls[] across all kept Symbols
  "resolvedCalls": 1203,  // Call.resolved != null
  "unresolved": {         // sums to totalCalls - resolvedCalls
    "localScope": 2, "external": 30, "dynamic": 60, "ambiguous": 3, "noMatch": 12
  }
}
```

Property names are the camelCase spelling of the kebab-case bucket ids above (`local-scope` → `localScope`, `no-match` → `noMatch`). Calls promoted to `Symbol.effects[]` by an effect plugin, and calls removed by Category C drop rules, never reach `calls[]` and are therefore not counted. Integrity invariant #15 ([`ir-schema.md`](./ir-schema.md) §14) re-derives all three numbers from `symbols[]` so the census cannot drift from the document it describes.

`aburi scan` and `aburi diff` render the object as one stdout line ([`cli-spec.md`](./cli-spec.md) §6.6), and the Slice View projection marks the affected members ([`slice-view.md`](./slice-view.md) §12.6) so a reviewer can tell a legitimately disconnected singleton from a resolver miss without a second command.

The per-call detail — which line, which bucket, which candidates — is **not** persisted. It travels in memory on `ScanResult.unresolvedCalls` and is rendered per Symbol by `aburi explain --debug-resolution`. Because the IR cannot carry it, that flag always rescans the workspace and refuses to combine with `--no-rescan` or `--ir`.

### 8.2 Determinism under partial failures

- LSP timeout on a specific call → that call falls back to the untyped tier's answer. It does not degrade any other call site's confidence.
- Missing `symbolTable` entry for an imported file (e.g. `.d.ts` intentionally not scanned) → treated as external. Confidence `high` on the negative result.
- Cycle in imports → does not affect resolution (resolution is per-call, not transitive).

### 8.3 Non-goals

Explicitly out of scope:

- **Renaming a resolved id after the fact** (e.g. following re-exports transitively across five files). The first matching Symbol id wins; if that Symbol re-exports another, the edge points at the re-exporter, not the origin. Rationale: transitive re-export following is stateful and hurts determinism.
- **Adding a distinction beyond what the qname convention already carries.** [`ir-schema.md`](./ir-schema.md) §3.2 already distinguishes instance vs. static methods at the qname level (`ClassName.method` vs. `ClassName::method`), so an instance-call and a static-call resolve to different Symbol ids without further work. The resolver does not add any extra layer on top: whatever the language plugin's qname says is the identity of the callee, that is the identity used in `resolved`.
- **Confidence numbers.** Categorical only, per [`overview.md`](./overview.md) §2.

## 9. Determinism Guarantees

The resolver's output is a pure function of its inputs. Given the same `symbolTable`, same `importTable`, same `receiverTypes` (or an empty LSP layer), the same `(Symbol, Call)` pair produces the same `resolved` and same confidence, **byte-for-byte**.

- No timestamps, no random tiebreaks, no dependence on OS filesystem enumeration order.
- Multi-candidate tiebreak is lexicographic on Symbol id (§5.5).
- Parallel resolution across files is allowed but the final `calls[]` array in each Symbol is re-sorted per [`ir-schema.md`](./ir-schema.md) §1 (ascending by `line`) before IR emission.

Time-series diff stability follows directly: adding a call in file A never changes the resolution of an existing call in file B.

## 10. Verifiable Properties (Test Criteria)

Every implementation of the resolver must pass the following.

### 10.1 Untyped-tier resolution

| ID | Input | Expected |
|---|---|---|
| CR1 | same-file top-level function call (`foo()`) | `resolved` = same-file Symbol id, confidence `high` |
| CR2 | named-import call (`import { X } from './y'; X()`) | `resolved` = `<lang>:./y#X`, confidence `high` |
| CR3 | aliased named-import (`import { X as A } from './y'; A()`) | `resolved` = `<lang>:./y#X`, confidence `high` |
| CR4 | namespace import (`import * as N from './y'; N.foo()`) | `resolved` = `<lang>:./y#foo`, confidence `high` |
| CR5 | default import (`import D from './y'; D()`) | `resolved` = `<lang>:./y#<default>`, confidence `high` |
| CR6 | type-only import used as call — cannot happen at runtime but resolver sees the string | `resolved` = `null`, confidence `high` |
| CR7 | bare specifier (`import { sortBy } from 'lodash'; sortBy()`) | `resolved` = `null`, confidence `high` |
| CR8 | dynamic import (`await import('./y')`) — no direct call at the site | no `Call` entry, no edge |
| CR9 | call to a parameter (`function f(cb) { cb() }`) | `resolved` = `null`, confidence `high` (local shadow) |
| CR10 | call to a local nested function | `resolved` = `null`, confidence `high` |
| CR11 | qualified cross-file same-component (`PricingService.calc()` no import) | `resolved` = that Symbol id when unique, confidence `medium` |
| CR12 | qualified workspace-scope (no import, unique globally) | `resolved` = that Symbol id, confidence `low` |
| CR13 | ambiguous qualified name (two matches) | `resolved` = `null`, confidence `medium` |
| CR14 | `this.<method>` in untyped mode | `resolved` = `null`, confidence `medium` |
| CR15 | `new <ClassName>()` where class is imported | `resolved` = the class Symbol id, confidence `high` |

### 10.2 LSP-tier resolution

| ID | Input | Expected |
|---|---|---|
| CR16 | `this.foo()` in class C with method `foo` | `resolved` = `C.foo`, confidence `high` |
| CR17 | `this.foo()` inherited from parent class B | `resolved` = `B.foo`, confidence `medium` |
| CR18 | `super.foo()` | `resolved` = parent's `foo` Symbol, confidence `high` |
| CR19 | interface-typed receiver with single implementer | `resolved` = implementer's method, confidence `medium` |
| CR20 | interface-typed receiver with multiple implementers, no framework hook | `resolved` = `null` |
| CR21 | interface-typed receiver, framework plugin's `resolveDispatch` returns a Symbol id | `resolved` = that id, confidence `medium` |
| CR22 | untyped tier already resolved → LSP tier leaves it alone | unchanged |

### 10.3 Determinism

| ID | Input | Expected |
|---|---|---|
| CR23 | resolve the same fixture twice | byte-identical `calls[]` output |
| CR24 | resolve with parallel workers = 1 vs. 4 | byte-identical `calls[]` output |
| CR25 | LSP server returns candidates in reverse order between two runs | byte-identical `resolved` (tiebreak wins) |
| CR26 | add an unrelated file elsewhere in the workspace | existing Symbols' `resolved` values unchanged (locality) |

### 10.4 Failure classification

| ID | Input | Expected |
|---|---|---|
| CR27 | `factory().save()` | `resolved` = `null`, diagnostic bucket `dynamic` |
| CR28 | typo callee (`foo()` where no `foo` exists) | `resolved` = `null`, diagnostic bucket `no-match` |
| CR29 | ambiguous cross-component qname | diagnostic bucket `ambiguous`, candidates recorded |

## 11. Design Decisions

### 11.1 Why five ordered steps instead of one graph search

A single "search everything" pass mixes strong and weak evidence. Splitting into ordered steps gives each step a **defensible confidence**: file / import matches are `high`, component scope is `medium`, workspace scope is `low`. Downstream consumers (effect propagation, Slice View) can then choose which confidence tier they trust.

### 11.2 Why untyped resolution ships before LSP

`overview.md` §2 rejects LSP-only for CI stability reasons. If the graph existed only when LSP was up, the Slice View and effect propagation would be unusable in the default `aburi scan` / `aburi diff` invocation. The untyped tier gives a usable graph for the common case (same-file, imported cross-file, qualified references) and LSP refines the residual.

### 11.3 Why local-scope callables produce `null` and not a synthetic Symbol id

Introducing anonymous Symbol ids (`<caller>#local:cb`) would clash with [`ir-schema.md`](./ir-schema.md) §3.3, which forbids anonymous Symbols from becoming independent entries. Emitting `null` keeps the IR schema honest and pushes the "runtime data" fact upstream where it belongs.

### 11.4 Why the resolver runs in `@aburi/core`, not in the language plugin

Resolution requires knowledge of every file's imports and every Symbol in the workspace. Only the core has that view; the language plugin operates one file at a time. Keeping resolution in the core also lets it be shared across languages (§7.3) once cross-language resolution is designed.

### 11.5 Why confidence is per-edge, not per-Symbol

An edge from A to B is a distinct fact from A's own confidence. Downgrading A's `confidence` because one of its outgoing edges is `low` would be a category error. Effect propagation is where the two confidences combine — see [`effect-propagation.md`](./effect-propagation.md) §5.3.

### 11.6 Why re-export transitivity is not followed

A barrel file `packages/domain/index.ts` re-exporting `export { Invoice } from './invoice'` would let a caller see either `packages/domain/index.ts#Invoice` or `packages/domain/invoice.ts#Invoice` as the resolution target. Transitively following the re-export requires reading every barrel in dependency order, which is stateful and race-prone. The first-match rule (§4.4 hits the barrel; the barrel is a Symbol; done) is deterministic. Downstream tooling that cares about the ultimate origin can walk `Dependency` edges to find it.

### 11.7 Why an unresolvable call is high-confidence

`resolved = null` with `confidence = high` is the honest description of "this call is genuinely a runtime dispatch or an external library". It is not a guess. The framework/effect classification path is what carries the actual semantics (`db.write` etc.); the graph edge is only there when both endpoints are workspace Symbols. Treating "no edge" as a first-class high-confidence outcome removes the temptation to fabricate weak edges just to make the graph denser.
