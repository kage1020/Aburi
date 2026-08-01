# IR Schema (`aburi.ir.v1`)

Schema definition of the Intermediate Representation (IR) emitted by Aburi.
The JSON Schema at `schema/aburi.ir.v1.json` is the single source of truth; this document states the rationale behind the design decisions.

---

## 1. File Format, Ordering, and Key Presence

- Format: JSON (UTF-8, LF)
- Indentation: 2 spaces (default), single line with `--compact`
- Top-level keys: ascending alphabetical order
- Array ordering (fixed for diff stability):
  - `components[]`: ascending by `id`
  - `symbols[]`: ascending by `id`
  - `dependencies[]`: lexicographic by (`from`, `to`, `via`)
  - `decorators[]` / `rules[]` / `effects[]` / `calls[]` within a Symbol: ascending by `line` (source order within the same line)

The ordering convention is a **precondition for diff stability**. Spurious diffs caused by array order must never occur.

### 1.1 Absent key vs explicit `null`

An absent key and an explicit `null` are **not** interchangeable. Every optional property fixes one of the two as its way of saying "no value", and which one it is follows mechanically from the property's type:

> A property whose type admits `null` is **Class A (always-written)**.
> A property whose type does not admit `null` is **Class B (presence-carrying)**.
> No property may be both. A field that could be absent, `null`, *and* value-carrying would spend three states on two meanings; v1 contains none, and none may be added.

**Class A** — the value is unknown or does not apply, but the field itself always belongs on the record.

- A writer MUST emit the key on every record, carrying `null` when there is no value. It MUST NOT omit the key and MUST NOT substitute a placeholder (`0`, `""`, `[]`).
- A reader MUST treat an absent key exactly as `null`. It MUST NOT read absence as a state distinct from `null`.

The reader rule is what carries backward compatibility, and it is the more important of the two. A writer rule only governs code not yet written; documents already committed to a user's repository cannot be rewritten, and `aburi diff` reads a committed IR as its base ([cli-spec.md](./cli-spec.md) §6.3). Because absence and `null` are indistinguishable to a conforming reader, an older document that omits a Class A key stays correct rather than becoming a special case. The `?? null` normalizations throughout the core, diff, and projection packages are this rule's implementation, not defensive clutter.

**Class B** — the *presence* of the key is itself the information: "this pass ran", "this entry was propagated", "this document is new enough to carry the field".

- A writer MUST omit the key entirely when the condition does not hold. It MUST NOT substitute `[]`, `false`, or `null`, all of which would erase the distinction the field exists to draw.
- A reader MAY branch on `Object.hasOwn`. "Absent" and "empty" are different facts here.

| Field | Type admits `null` | Class | Writer rule |
|---|---|---|---|
| `generatedAt` | no | B | reserved for the producer's clock; **no writer emits it today**, so the key is always absent. `--no-timestamp` currently suppresses only the Markdown projection's "Generated" line |
| `stats.effectClassifyTimeouts` | no | B | omitted when no classification timed out |
| `stats.lspEnrichment` | no | B | omitted when the LSP pass did not run |
| `stats.callResolution` | no | B | always emitted by the current pipeline; absence means the document predates the counter |
| `Component.publicApi` | no | B | omitted when empty |
| `Component.frameworks` | no | B | omitted when empty |
| `Component.description` | **yes** | **A** | always emitted; `null` when the component carries no description |
| `Symbol.component` | **yes** | **A** | always emitted; `null` when the Symbol lies outside every Component |
| `Symbol.signature` | **yes** | **A** | always emitted; `null` for Symbols with no callable signature |
| `Signature.inferredThrows` | no | B | omitted when nothing was inferred; never `[]` (§7) |
| `Effect.line` | no | B | present iff the entry is locally detected (schema-enforced by the `allOf`'s required/forbidden flip, §9.4) |
| `Effect.propagated` | no | B | present iff `true`. Convention only — the schema's `if` treats `false` and absent alike, so `propagated: false` validates while violating this rule (§9.4) |
| `Effect.derivedFrom` | no | B | present iff `propagated` is `true` (schema-enforced by the same flip, §9.4) |
| `SourceRange.startColumn` | **yes** | **A** | always emitted; `null` until LSP enrichment fills it (§12) |
| `SourceRange.endColumn` | **yes** | **A** | always emitted; `null` until LSP enrichment fills it (§12) |

None of the Class A fields appear in `required`. That is a consequence of the v1 freeze (§15.2 makes optional → required breaking), not a statement about their meaning; §15.4 records the promotion as a v2 candidate.

Most of the table is convention that the schema cannot express, and the two rows marked schema-enforced are the exception rather than the rule: JSON Schema can say "this key is forbidden here and required there", which is what pins `Effect.line` and `Effect.derivedFrom`, but it cannot say "prefer absence over a `null` that validates". A document that breaks a Class A or Class B rule is therefore usually still a valid `aburi.ir.v1` document — the rules exist so that consumers do not have to handle both spellings, not so that validators reject one.

**How this reaches the JSON.** The canonical serializer drops object properties whose value is `undefined` and preserves `null` verbatim. A TypeScript `undefined` therefore *is* the Class B omission — which means assigning `undefined` to a Class A field is a convention violation that changes the emitted bytes while still type-checking. Nothing else in the pipeline rewrites key presence, so what a writer assigns is exactly what lands on disk.

**Why the schema does not use `"default": null`.** JSON Schema's `default` is an annotation; it does not participate in validation. Writing it would look like a declaration that absence means `null` while no validator treats it that way. The rule lives here and in each property's `description` instead.

**Adding an optional field to v1** means adding a row to the table above and stating the class in the property's `description` in `schema/aburi.ir.v1.json`. An optional property with no `description` has not declared its class, and `packages/types/test/schema-conventions.test.ts` fails on it.

## 2. Top-Level Structure (Document)

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.ir.v1.json",  // required
  "generator": {                              // required
    "name": "aburi",
    "version": "1.0.0",
    "plugins": [                               // required; records ALL plugins (lang/framework/effects)
      { "name": "lang-typescript",  "type": "lang",      "version": "1.0.0", "grammarRevision": "tree-sitter-typescript@0.23.2" },
      { "name": "framework-nestjs", "type": "framework", "version": "1.0.0", "grammarRevision": null },
      { "name": "effects-prisma",   "type": "effects",   "version": "1.0.0", "grammarRevision": null }
    ]
  },
  "generatedAt": "2026-06-19T15:30:00Z",      // Class B (§1.1); no writer emits it today
  "workspace": {                              // required
    "root": ".",
    "managers": [                             // required (empty array allowed)
      { "tool": "pnpm", "roots": ["packages/*", "apps/*"] }
    ],
    "languages": ["ts"]                       // required (short-form ids declared by lang plugins, e.g. ts/tsx/py/go/rs)
  },
  "components": [ /* Component[] */ ],        // required
  "symbols": [ /* Symbol[] */ ],              // required
  "dependencies": [ /* Dependency[] */ ],     // required
  "stats": {                                  // required
    "totalFiles": 18,
    "parsedFiles": 18,
    "keptSymbols": 27,
    "droppedSymbols": 7,
    "effectPropagation": {                    // required — emitted even when nothing propagated
      "sccCount": 27, "maxSccSize": 1, "propagatedEffectCount": 4, "symbolsWithPropagatedEffects": 2
    },
    "callResolution": {                       // Class B (§1.1); always emitted by the current pipeline
      "totalCalls": 131,
      "resolvedCalls": 120,
      "unresolved": {
        "localScope": 0, "external": 6, "dynamic": 4, "ambiguous": 0, "noMatch": 1
      }
    }
  }
}
```

- `$schema`: canonical URL. Used for IDE JSON Schema resolution and integrated validation
- `generatedAt`: operational metadata of the producer. **Excluded from fingerprint computation**. Class B per §1.1 — the key is omitted rather than nulled when there is no timestamp to record. No writer emits it today: the scan pipeline never sets it, and `--no-timestamp` currently reaches only the Markdown projection, where it suppresses the "Generated" line. A producer that does record a clock must drop the key when committing the IR, so that re-scanning an unchanged workspace produces an unchanged file
- `workspace.root`: always `"."`. Never write absolute paths (IR portability)
- `workspace.managers[].tool`: runtime-independent string. Representative values: `pnpm`/`npm`/`yarn`/`bun`/`uv`/`poetry`/`pip`/`cargo`/`go`/`mvn`/`gradle`/`hatch`/`pixi`. Unknown values are not rejected (so that adding a new tool never requires a schema revision)
- `stats`: for human/CI logs. Excluded from fingerprint
- `stats.callResolution`: the call-resolution census of [`call-resolution.md`](./call-resolution.md) §8.1 — how many call sites the resolver saw, how many it identified, and why the rest stayed `null`. Optional so documents produced before the field existed remain valid v1; the current scan pipeline always emits it, so absence means "this IR predates the counter", not "nothing was unresolved". The per-call reasons behind these counts are deliberately **not** persisted — see §8.1

## 3. Symbol ID Convention

### 3.1 Format

```
<language>:<file-path>#<qualified-name>
```

- `<language>`: identifier declared by the language plugin (`ts`, `tsx`, `js`, `py`, `go`, `rs`, ...)
- `<file-path>`: POSIX path relative to the workspace root (forward slashes enforced)
- `<qualified-name>`: name unique within the file

### 3.2 Building the qualified name

| Symbol | qualified name |
|---|---|
| top-level function / const / var | `createInvoice` |
| class | `InvoiceService` |
| instance method | `InvoiceService.createInvoice` |
| static method | `InvoiceService::fromJson` |
| nested namespace / class | `Billing.Invoice.create` |
| interface / type alias | `Invoice` |
| default export (including anonymous functions/classes) | `<default>` |
| function/class expression assigned to a variable | the variable name becomes the qname (e.g. `const handler = () => ...` → `handler`) |

### 3.3 Handling anonymous symbols

Anonymous symbols do not become independent Symbol entries. Callbacks, immediately-invoked function expressions, and anonymous function arguments are **absorbed into the parent Symbol's `calls` / `effects` / `rules`**. Position-dependent IDs (of the `<anon@L42>` kind) must not be used (they break diff stability).

The only exceptions are `<default>` and "function expressions assigned to a variable" from §3.2. These are named entry points, so they get a Symbol.

### 3.4 ID stability

- IDs generated by the same Aburi version for the same input match exactly
- Renaming parameters or local variables does not change the ID
- Moving a file changes the ID (the `<file-path>` part changes) → the Diff algorithm assigns the `moved` status via git rename + fingerprint matching

### 3.5 ID namespaces

Aburi mints three kinds of identifier, and each owns a namespace the other two must not reach into:

| Identifier | Shape | Minted by |
|---|---|---|
| Symbol ID | `<language>:<file>#<qname>` (§3.1) | `makeSymbolId` / `trySymbolId` in `@aburi/core` |
| Component ID | ASCII kebab-case (§4) | `makeComponentId` in `@aburi/core` |
| Slice ID | `"slice:" + <anchor Symbol ID>` ([slice-view.md](./slice-view.md) §7.1) | `sliceIdFor` in `@aburi/diff` |

Two rules keep the namespaces from overlapping:

1. **`slice` is a reserved language token.** A language plugin claiming it would mint Symbol IDs shaped exactly like Slice IDs, and deriving a Slice ID from one of those would produce `slice:slice:…`. `makeSymbolId` rejects the token; see [multi-language-id.md](./multi-language-id.md) Rule L-11.
2. **The three types are nominal, not structural.** On the wire all three are JSON strings, and JSON Schema has no way to say otherwise. `@aburi/types` layers a brand onto each generated alias so `SymbolId`, `ComponentId`, and `SliceId` are mutually non-assignable in TypeScript and a bare `string` satisfies none of them.

A brand is minted only by the constructors above. Assertions (`x as SymbolId`) live in four documented places and nowhere else, and a test in `@aburi/e2e-integration` fails if a fifth appears under `packages/*/src`:

| Where | Why |
|---|---|
| `packages/core/src/id.ts` | The two id constructors. Both run the full grammar check first |
| `sliceIdFor` in `packages/diff/src/slice.ts` | The only `SliceId` constructor |
| `sliceRecordViolation` in `packages/diff/src/slice.ts` | Takes `unknown` by contract — it inspects records that have not been type-checked |
| `readIR` in `packages/cli/src/ir-io.ts` | Brands a whole parsed document at once (`as unknown as IR`), which is the only way to type a JSON parse. Invariant #17 in §14 is what checks the ids inside it |
| per-package test fixtures | A case that feeds a *malformed* id to the code that rejects it has to be able to write one |

The brands are erased at runtime and are absent from the JSON. They constrain what the codebase can build, not what a document may contain — shape checking on the wire remains the job of the schema and of §14.

`dependencies[].from` / `.to` are typed `SymbolId | ComponentId` because §11 lets a single array hold both endpoint kinds. Which one a given endpoint *is* gets recovered from its shape. Two flavours of that test exist and they are not interchangeable: `isSymbolId` / `isComponentId` in `@aburi/core` answer "is this a well-formed id?" and narrow, while the integrity checker and the Markdown projection use deliberately looser silhouette tests that return a plain `boolean` — a malformed endpoint still has to be routed to the Symbol-id invariants so the breach is reported, and handing it the brand would break the property that holding a `SymbolId` means having gone through a constructor.

## 4. Component

A logical boundary of the monorepo. Independent of physical packages.

```jsonc
{
  "id": "billing",                            // required, unique, ASCII kebab-case
  "name": "Billing",                          // required, human-facing label
  "roots": ["apps/billing", "packages/billing-domain"],  // required, POSIX relative
  "publicApi": [                              // optional, Class B (§1.1) — omitted when empty
    "apps/billing/src/routes/**",
    "ts:packages/billing-domain/src/index.ts#Invoice"
  ],
  "languages": ["ts"],                        // required, short-form lang ids
  "frameworks": ["nestjs"],                   // optional, Class B (§1.1) — omitted when empty
  "description": null                         // Class A (§1.1) — always present, null when unset
}
```

- `description` is Class A per §1.1 — always written, `null` when nothing supplied it. Only the config path (`components[].description`) can supply one today; automatic detection has no source for it and always writes `null`
- `id` is fixed to ASCII kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`) so it can be used in URLs and CLI arguments. A segment may start with a digit: the id is derived by kebab-casing a package or directory name ([component-detect.md](./component-detect.md) §4.1), and `3d-force-graph` is an ordinary npm package name
- Each element of `publicApi` is either a **glob** or a **symbol id**
- Physical Component boundary inference automatically reads package manager configuration (`pnpm-workspace.yaml`, `turbo.json`, `go.work`, `Cargo.toml` workspace, `pyproject.toml`/uv workspaces, etc.); see the separate document `component-detect.md` for details

## 5. Symbol

The core entity of the review unit.

```jsonc
{
  "id": "ts:apps/billing/src/InvoiceService.ts#InvoiceService.createInvoice",  // required
  "kind": "method",                           // required, enum §5.1
  "extKind": null,                            // required, nullable; language extension §5.2
  "name": "InvoiceService.createInvoice",     // required, qualified name
  "language": "ts",                           // required, short-form lang id (e.g. ts / tsx / py / go / rs)
  "component": "billing",                     // Class A (§1.1) — always present, null = outside any component
  "visibility": "public",                     // required, enum §5.3
  "decorators": [ /* Decorator[] */ ],        // required
  "signature": { /* Signature */ },           // Class A (§1.1) — always present, null = no signature
  "rules": [ /* Rule[] */ ],                  // required
  "effects": [ /* Effect[] */ ],              // required
  "calls": [ /* Call[] */ ],                  // required
  "source": { /* SourceRange */ },            // required
  "fingerprint": { /* Fingerprint */ },       // required
  "confidence": "high",                       // required, enum §5.4
  "derivedBy": ["framework:nestjs:controller", "branch-condition"],  // required
  "dropped": false,                           // required
  "dropReason": null                          // required, non-null when dropped=true
}
```

`component` is Class A per §1.1, so the key is on every Symbol and `null` means "outside every declared Component". Read the sample above as the shape the field is designed for, not as output you will see today: **the scan pipeline does not assign Symbols to Components yet**, so every Symbol it emits carries `null`. Consumers that group by Component — the per-component Markdown pages, the workspace overview's per-Component counts — therefore see empty groups on a real scan.

### 5.1 `kind` (core enum)

`"function" | "method" | "class" | "interface" | "type" | "const" | "module" | "namespace" | "variable" | "enum" | "constructor"`

Anything outside the core enum is expressed via `extKind`. A consumer may treat an unknown `kind` as an error (= strict enum).

### 5.2 `extKind` (language extension)

Either `null` or a string of the form `<namespace>(:<segment>)+`. At least 2 segments, arbitrarily deep. The namespace is a language/paradigm identifier:

| namespace | examples | owning plugin |
|---|---|---|
| `fp:*` | `fp:match`, `fp:adt`, `fp:effect` | functional-language plugins |
| `oop:*` | `oop:abstract`, `oop:trait` | OOP extension plugins |
| `meta:*` | `meta:macro`, `meta:proc-macro` | macro-language plugins |
| `framework:*` | `framework:nestjs:guard`, `framework:react:hook` | framework plugins |

When `extKind` is non-null, `kind` must hold the closest core kind (`kind: "function"` when `extKind: "fp:match"`). Consumers that only read the core vocabulary can ignore `extKind`.

### 5.3 `visibility` (enum)

`"public" | "private" | "protected" | "internal" | "package"`

- `public`: explicit export or public modifier
- `private` / `protected`: in-class visibility as-is
- `internal`: visible within the workspace but not exposed externally
- `package`: visible within the monorepo package but not exposed outside the component

### 5.4 `confidence` (enum)

`"high" | "medium" | "low"`

Criteria:

| Value | Criterion |
|---|---|
| `high` | Explicit in the AST (export modifier, throw statement, if statement), or explicitly declared by a framework/effect plugin |
| `medium` | Identifier match (inferring `db.write` from `prisma.invoice.create`), or determination from naming conventions (`*Service`, `*Controller`) |
| `low` | Heuristic (symbol connectivity or file location is the only evidence) |

Symbols with `low` confidence get a badge in the Markdown projection so reviewers clearly know the machine is not confident.

### 5.5 `derivedBy` (evidence)

A string array indicating why this symbol was extracted in this form. Each entry takes one of the following forms:

- `<rule>` — a core extraction rule (`branch-condition`, `throw-statement`, `export-keyword`)
- `framework:<name>:<role>` — determined by a framework plugin (`framework:nestjs:controller`)
- `effects-plugin:<name>:<action>` — determined by an effect plugin (`effects-plugin:prisma:write`)
- `convention:<name>` — determined by a naming/structural convention (`convention:service-suffix`)

An empty array means "picked up automatically by the core extraction path".

### 5.6 `dropped`

- `false` (default): included in the IR output
- `true`: judged to be decoration, but kept for transparency about what was dropped

Symbols with `dropped: true` have `rules`/`effects`/`calls`/`fingerprint` set to their prescribed values (empty arrays / all fingerprints = "0"*12). The Markdown projection aggregates them in a collapsed `## Dropped` section (see [markdown-projection.md](./markdown-projection.md) §3.6). `aburi explain` outputs the full details. `dropReason` is a short human-readable phrase (e.g. `"pure DTO"`, `"logger boilerplate"`, `"generated file"`).

## 6. Decorator

```jsonc
{
  "name": "Post",                             // required
  "raw": "Post('/invoices')",                 // required, verbatim source
  "arguments": ["'/invoices'"],               // required, string representations of the arguments
  "boundary": true,                           // required
  "line": 14                                  // required
}
```

The `boundary: true` determination is made by the framework plugin. The Aburi core does not hardcode it.

## 7. Signature

```jsonc
{
  "inputs": [
    { "name": "createInvoiceDto", "type": "CreateInvoiceDto" }
  ],
  "outputs": ["Promise<Invoice>"],
  "throws": ["CreditLimitExceeded"],
  "inferredThrows": ["NetworkError"],         // Class B (§1.1): absent unless LSP enrichment inferred something
  "async": true,
  "generator": false,
  "typeParameters": []
}
```

- `type` is the string representation as read from the AST. No type resolution is performed (LSP enrichment may optionally normalize it)
- `throws` combines explicit throw statements and JSDoc `@throws`
- `inferredThrows` holds throws the LSP enrichment pass read off the *callees'* declared signatures ([lsp-enrichment.md](./lsp-enrichment.md) §7.1). It is a field of its own rather than an addition to `throws` precisely so that turning LSP on never perturbs the `api` fingerprint, whose input list names `throws` and not `inferredThrows` ([fingerprint.md](./fingerprint.md) §3.1)
- `inferredThrows` is **Class B** per §1.1: when the pass inferred nothing — because no callee declared a throw, or because it fell back — the key is omitted outright. It is never emitted as `[]`, and the schema enforces `minItems: 1` so that an empty array cannot be written by accident
- A Symbol's entire `signature` may be `null` (class bodies, whole interfaces). It is **Class A** per §1.1, so the key is present on every Symbol

## 8. Rule

Semantically meaningful branches, exceptions, loops, and compound returns in the control flow.

```jsonc
{
  "type": "guard",                            // required, enum §8.1
  "line": 58,                                 // required
  "condition": "customer.creditLimit < invoice.total",  // type=guard/switch/match only
  "what": null,                               // type=throw only
  "expr": null,                               // type=return only
  "loopKind": null                            // type=loop only ("for"|"while"|"do")
}
```

### 8.1 `type` (enum)

`"guard" | "throw" | "return" | "loop" | "try" | "switch" | "match"`

- `guard`: an `if` statement containing an early return / throw / continue
- `throw`: a throw statement
- `return`: any non-trivial return (trivial determination per `drop-list.md`)
- `loop`: for / while / do
- `try`: try-catch (rules inside the catch body are not expanded into the same Symbol's rules)
- `switch`: a switch statement
- `match`: pattern matching (used only in symbols with `extKind: "fp:match"`)

### 8.2 Extraction conventions

- The same AST node must not produce multiple Rules
- `condition`/`what`/`expr` are whitespace-normalized (consecutive whitespace collapsed to one, newlines removed, trailing `...` when over 120 characters)
- Simple returns such as `return x` / `return true` do not become Rules (inclusion follows the trivial determination in `drop-list.md`)

## 9. Effect

The result of side-effect detection.

```jsonc
{
  "id": "db.write",                           // required, effect tag §9.1
  "target": "prisma.invoice.create",          // required, callee string
  "line": 75,                                 // required
  "plugin": "effects-prisma",                 // required, detection source
  "confidence": "high"                        // required, same enum as Symbol
}
```

### 9.1 Core effect vocabulary

A fixed set in `namespace:action` form. Only concepts that hold universally across any runtime/language.

| Category | Values |
|---|---|
| `db.*` | `db.read`, `db.write`, `db.transaction`, `db.migration` |
| `network.*` | `network.http`, `network.ws`, `network.rpc` |
| `queue.*` | `queue.publish`, `queue.consume` |
| `event.*` | `event.publish`, `event.subscribe` |
| `fs.*` | `fs.read`, `fs.write` |
| `state.*` | `state.mutate`, `collection.mutate` |
| `time.*` | `time.now`, `time.timer` |
| `random` | `random` |
| `env.*` | `env.read`, `env.write` |
| `process.*` | `process.exit`, `process.signal` |

Within schema version `aburi.ir.v1`, this set is additive-only; deletion and semantic change are forbidden.

### 9.2 Plugin-extended effects

Effects specific to a particular runtime/library/domain are declared by the plugin with the `x-<plugin>:<action>` prefix.

Examples:
- `x-stripe:charge`
- `x-s3:upload`
- `x-nest:lifecycle.on-module-init`
- `x-auth:permission-check`
- `x-react:state-update`

Consumers must tolerate unknown `x-` effects; the Markdown projection sections them by prefix.

### 9.3 Separation of Effect and Call

If a call_expression is recognized by an effect plugin, it is recorded in `effects[]` only, not in `calls[]`. No duplicate output.

### 9.4 Propagated effects

`Effect` records may carry the optional fields `propagated: boolean` and `derivedFrom: SymbolId[]` when produced by the effect-propagation pass; see [`effect-propagation.md`](./effect-propagation.md) §5. On entries with `propagated: true`, the `line` field is **omitted from the JSON output** — not set to `null`, not set to a placeholder — because the effect originates N hops away and has no line in the containing Symbol's body. The JSON Schema (`aburi.ir.v1.json`) narrows `line` accordingly: required when `propagated` is absent or `false`; forbidden when `propagated` is `true`. These extensions are non-breaking under §15.2.

`propagated` is itself Class B per §1.1, so a writer records a locally-detected entry by **omitting** the key, never by writing `propagated: false`. The schema's condition is `propagated` present *and* `true`, which puts absent and `false` on the same branch — so a `false` validates and is read correctly by every consumer, but it spends a key to say what absence already says. The distinction matters when reading these rules together: the schema pins where `line` and `derivedFrom` may appear, while the choice between absent and `false` is convention only.

## 10. Call

A call that does not qualify as an effect.

```jsonc
{
  "target": "pricing.calculateTotal",         // required
  "line": 70,                                 // required
  "resolved": null                            // optional, resolved symbol id
}
```

`resolved` is filled in by the call-resolution feature (separate document). `null` while unresolved.

## 11. Dependency

An edge between symbols or between components. Both endpoint kinds live in the same `dependencies[]` array — the schema for `from`/`to` is a plain `string`, and the endpoint kind is recovered from the id shape (`<language>:<file>#<qname>` for a Symbol id, ASCII kebab-case for a Component id).

```jsonc
{
  "from": "billing",                          // required, symbol id or component id
  "to":   "pricing",
  "via":  "import",                           // required, enum
  "direction": "outbound",                    // required, enum
  "effect": null                              // optional, related effect tag
}
```

### 11.1 `via` (enum)

`"import" | "call" | "inherit" | "implement" | "compose" | "http" | "event" | "sql"`

`"call"` is reserved for symbol-to-symbol edges emitted from the resolved call graph (see `call-resolution.md` §7). Symbol-to-symbol Dependencies are always emitted with `direction: "outbound"` and `effect: null`. Per-edge confidence and caller-site line are held on the resolver's internal `CallEdge` shape (`call-resolution.md` §7.1) and deliberately NOT projected onto Dependency — `Call.resolved` is `SymbolId | null` alone. The caller-site line still survives on `Symbol.calls[].line`; per-edge confidence is not persisted at all in v1 and is a candidate for a `Call.confidence` extension in a later phase.

### 11.2 `direction` (enum)

`"outbound" | "inbound" | "bidirectional"`

The direction as seen from `from`. `bidirectional` is limited to cases such as bidirectional RPC.

## 12. SourceRange

```jsonc
{
  "file": "apps/billing/src/InvoiceService.ts",  // required, POSIX relative
  "startLine": 42,                            // required, 1-based
  "endLine": 91,                              // required
  "startColumn": null,                        // Class A (§1.1), 1-based; null until LSP enrichment
  "endColumn": null                           // Class A (§1.1), 1-based; null until LSP enrichment
}
```

`startColumn` / `endColumn` are filled in during LSP enrichment ([lsp-enrichment.md](./lsp-enrichment.md) §4.2). Until then — and under any LSP fallback ([lsp-enrichment.md](./lsp-enrichment.md) §6.2) — they are `null`, not absent: "no column recorded" is a value, not a missing field.

The Tree-sitter tier is not *unable* to produce a column — the parse tree carries one — but the in-tree TypeScript plugin deliberately does not publish it, so that every column in an Aburi IR comes from `textDocument/documentSymbol` and one convention about what a column counts. A plugin that has a column and wants to publish it may ([lang-plugin.md](./lang-plugin.md) §4.3); a successful LSP pass overwrites it either way.

They are **Class A** per §1.1. A writer MUST emit both keys on every `SourceRange`; a reader MUST read an absent key as `null`. They stay out of `required` only because promoting an optional field is breaking under §15.2 — see §15.4.

## 13. Fingerprint

```jsonc
{
  "api": "9ee77913af43",                      // required, 12 hex
  "logic": "7ecf8c1cebe7",                    // required, 12 hex
  "syntax": "a3f2e1d0c9b8"                    // required, 12 hex
}
```

See the separate document `fingerprint.md` for the exact computation. This document only stipulates that "there are three 12-hex strings" and that "the fingerprint computation includes no noise other than `generatedAt` / `stats` / array order".

Roles of the three axes:

| Axis | Changes when | Invariant under |
|---|---|---|
| `api` | signature / visibility / boundary decorator changes | body implementation changes |
| `logic` | changes to the set of rules / effects | local variable renames / method reordering / comments / added decoration |
| `syntax` | any AST structural change | formatting-only changes |

For symbols with `dropped: true`, all fingerprints are fixed to the 12-hex string `"000000000000"`.

## 14. Invariants

Guaranteed by the schema validator plus Aburi internals:

1. `symbols[].id` is unique within the Document
2. `components[].id` is unique within the Document
3. If `symbols[].component` is non-null, it exists in `components[].id`
4. If `dependencies[].from` / `to` is in symbol-id form, it exists in `symbols[].id`
5. If `dropped: true`, `dropReason` is non-null
6. `confidence` ∈ §5.4 enum
7. `effects[].id` is in the §9.1 core vocabulary or carries an `x-<plugin>:` prefix
8. `kind` is in the §5.1 enum
9. `extKind` is `null` or of the form `<namespace>(:<segment>)+` (at least 2 segments, arbitrarily deep)
10. All paths are POSIX (forward slash), relative to the workspace root
11. The array-ordering conventions (§1) are satisfied
12. If `dependencies[].via` is `"call"`, both `from` and `to` are symbol ids present in `symbols[].id` (strengthens #4 for call edges — a call edge with a component-id endpoint or a dangling symbol id is rejected outright)
13. Within `dependencies[]`, the triple `(from, to, via)` is unique — the same directed edge cannot be recorded twice
14. For every `Symbol.calls[]` entry with a non-null `resolved`, there is a matching Dependency `{ from: caller.id, to: resolved, via: "call" }` in `dependencies[]`, and conversely every `via: "call"` Dependency corresponds to at least one such Call entry (the call-graph projection is total and lossless in both directions)
15. When `stats.callResolution` is present, it is a faithful census of `symbols[].calls[]`: `totalCalls` equals the number of call sites, `resolvedCalls` equals the number with a non-null `resolved`, and the five `unresolved` buckets sum to the difference. A drift here would report unresolved calls the document does not contain, or hide ones it does
16. No `symbols[].id` and no `dependencies[].from` / `.to` uses a reserved language token (§3.5) — today that means no id begins `slice:`, which would be indistinguishable from a Slice id and would make the Slice-id derivation produce `slice:slice:…`
17. `symbols[].id` and `components[].id` satisfy the grammars of §3.1 and §4. Every other route to an id runs a constructor that enforces this; a document read from disk has its ids branded by a single whole-document assertion, and this is where they are actually checked

An invariant violation is a **fatal error**, not a warning.

## 15. Versioning

### 15.1 `$schema` URL

- Fixed to `https://aburi.dev/schema/aburi.ir.v1.json`
- Backward-compatible field additions: allowed within v1
- Field removal / type change / semantic change: goes to v2. Change `$schema` to `aburi.ir.v2.json`

### 15.2 Compatibility policy

| Change | Compatibility |
|---|---|
| Adding a required field | breaking |
| Adding an optional field | non-breaking |
| Adding an enum value (only where consumers tolerate unknowns) | non-breaking |
| Removing an enum value | breaking |
| Required → optional | non-breaking |
| Optional → required | breaking |
| Renaming a field | breaking |
| Changing array-ordering rules | breaking |

Because consumers may treat unknown `kind` values as errors, additions to the `kind` enum are also treated as breaking. `extKind` / `derivedBy` / `effects[].id` (x- extensions) / `via` are close to free-form strings, so additions are unrestricted.

### 15.3 Freezing the core effect vocabulary

The core effect vocabulary of §9.1 is **additive-only** within version v1. Deletion and semantic change are forbidden. Plugin extensions are fully separated by the `x-` prefix, so freezing the core does not hinder plugin evolution.

### 15.4 Deferred to v2

Shapes the schema would have if v1 were not frozen, recorded here so the reasoning is not rediscovered:

- **Promote the five Class A fields of §1.1 — `Symbol.component`, `Symbol.signature`, `Component.description`, `SourceRange.startColumn`, `SourceRange.endColumn` — into `required`.** Breaking per §15.2, and the breakage is concrete rather than theoretical: every document generated before the promotion becomes invalid, and `aburi diff` reads a committed IR as its base, so a repository that commits its IR would see a green CI turn red without anyone touching the repository. That every writer in this codebase already satisfies the constraint does not change that.

Whether the promotion is worth doing in v2 at all is open. The §1.1 reader rule already makes an absent key and `null` indistinguishable to every conforming consumer, so promoting buys stricter validation of third-party producers and nothing else.

## 16. Extension Points

Places where Aburi can be extended without forking the core:

| Extension target | Location | Extension form |
|---|---|---|
| Special concepts of a new language | `extKind` | `<namespace>:<kind>` |
| Runtime/library-specific effects | `effects[].id` | `x-<plugin>:<action>` |
| Additional extraction evidence | `derivedBy` | free-form string (by convention `<plugin>:<reason>`) |
| Logical Component boundaries | `components[]` (via config) | arbitrary |

To avoid breaking compatibility, the design is deliberately asymmetric: fields consumed by the Aburi core are strict enums, while fields extended by plugins are free-form strings.
