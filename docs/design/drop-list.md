# Drop List Standard Set

The core convention behind Aburi's differentiating extraction strategy of "stripping decoration".
Defines which files, symbols, and nodes are removed from the IR, and when the fact of removal is retained as `dropped: true`.

See: [`ir-schema.md`](./ir-schema.md) §5.6 (dropped convention) / §8.2 (Rule extraction convention)
Extension mechanism: [`extension-vocab.md`](./extension-vocab.md) (for plugins that add drop rules)

---

## 1. Purpose

Identify and remove decorative, ceremonial, and self-evident structure so that the extraction pipeline keeps only meaningful logic.
A low-noise IR means:

- diff reports show only the semantic changes, increasing review focus
- fewer tokens when an AI consumer reads the IR
- stable fingerprints (adding decoration does not flood the diff)

drop means "removed from view", not "discarded". For transparency, symbol-level drops remain in the IR as `dropped: true`.

## 2. The four drop tiers

| Tier | Granularity | Treatment in the IR |
|---|---|---|
| A. File-level skip | Entire file | Never appears in symbols/dependencies (also excluded from stats.totalFiles) |
| B. Symbol-level drop | Single Symbol | Retained with `dropped: true` + `dropReason`; fingerprint is all zeros |
| C. Node-level filter | call / return / decorator inside a Symbol | Individually excluded from call/return/effect/rule; the Symbol itself remains |
| D. Config/Plugin extension | Layered on top of all of A/B/C | Follows the evaluation order in §7 |

## 3. Category A: File-level skip

Excludes an entire file from extraction. The file is not even AST-parsed.

### 3.1 Core standard patterns

| Pattern | Reason |
|---|---|
| `**/node_modules/**` | Dependency libraries |
| `**/dist/**` `**/build/**` `**/out/**` `**/target/**` | Build artifacts |
| `**/.next/**` `**/.nuxt/**` `**/.svelte-kit/**` `**/.output/**` | Framework build caches |
| `**/coverage/**` | Coverage reports |
| `**/__snapshots__/**` `**/*.snap` | Test snapshots |
| `**/*.d.ts` `**/*.d.mts` `**/*.d.cts` | TS type declaration files (no implementation) |
| `**/*.generated.*` `**/*.gen.*` `**/*.g.ts` | Auto-generated |
| `**/*.min.js` `**/*.bundle.js` | minified/bundled |
| `**/__pycache__/**` `**/*.pyc` | Python caches |
| `**/.venv/**` `**/venv/**` `**/site-packages/**` | Python virtual environments |
| `**/target/**` `**/Cargo.lock` | Rust |
| `**/vendor/**` `**/go.sum` | Go |

### 3.2 Additions by language plugins

Each language plugin may add skip patterns specific to its own language. Examples:

- `lang-typescript`: `**/*.d.ts`, `**/*.config.{js,ts,mjs,cjs}` (optional)
- `lang-python`: `**/__pycache__/**`, `**/*.pyi`
- `lang-rust`: `**/target/**`, `**/Cargo.lock`

### 3.3 .gitignore integration

`.gitignore` is respected by default (turned off by `config.respectGitignore: false` or `--no-respect-gitignore`, and back on for one run by `--respect-gitignore`).

Files ignored by git are therefore skipped automatically without listing `dist/` etc. explicitly.

It is decided the way git decides it, which is not the same as adding its lines to the Category A glob list. Git's rules pull in opposite directions — a later `!rule` re-includes a file, and *nothing* re-includes a file under a directory that was excluded outright, because git never descends into it — and a glob list can express neither. So each file is compiled into its own matcher and every discovered candidate is asked about the chain of them above it, rather than the walk being pruned by any. The consequence worth knowing: a `.gitignore`d directory is still walked. What such a file usually names is in the Category A list above and is pruned there.

**The Category A globs are outside a negation's reach.** The core patterns, `config.ignore[]` (§3.4) and language-plugin drop patterns prune the walk, and no `!` line in `.gitignore` brings back a file they excluded — those are not gitignore rules and the matcher never sees the candidate.

Matching is case-sensitive, whatever the filesystem is. Git folds case only where `core.ignoreCase` says so, so no single answer agrees with git on every platform; folding would drop a file git keeps wherever git is case-sensitive, which is the failure this mechanism exists to prevent. Reading `core.ignoreCase` would settle it and is refused for a different reason — it would make the Document depend on the machine's git configuration.

One thing "the way git decides it" does not cover: git applies `.gitignore` to untracked files only, so a tracked file matching a rule is not ignored. There is no index here, so such a file is excluded.

**Every directory's file, not just the root's.** Git consults a `.gitignore` in each directory from the repository root down to the file's own, and a deeper file's rules override a shallower one's — `packages/app/.gitignore` holding `fixtures/` is the ordinary way to say a package's fixtures are not source. Precedence is per directory rather than per line: two files that disagree about one path are decided by which is deeper, whichever direction each points. A nested file's patterns are relative to its own directory, so `/local.ts` in `packages/app` anchors to `packages/app/local.ts`.

The directory rule above still holds across files: nothing re-includes a file under a directory that was excluded, so a root `gen/` cannot be undone by `gen/.gitignore` holding `!keep.ts`. A root `gen/*` can, because it never excluded the directory.

**Not read**, and not by accident: `$GIT_DIR/info/exclude` and `core.excludesFile`. Both live outside the tree and are per-machine, so honouring them would make the Document depend on who ran the scan — the determinism [`ir-schema.md`](./ir-schema.md) §1 exists to defend. A `.gitignore` is committed, so every clone answers the same. `.git/.gitignore` is not a rule file to git and is not one here.

A rule file is opened by descending to it, as git finds it — so one under a directory that has no surviving candidate is never opened at all. That covers a directory the Category A globs dropped, a directory an outer `.gitignore` excluded, and `.git` itself. It is not only that such a file's rules would be inert; an unusable one would otherwise end a run git would not even have opened it during.

A rule longer than 4,096 characters is refused with the file and the line named, without being handed to a regex engine at all. That is a determinism rule, not a style one: where the engine's own size limit falls is the engine's business, and the same `.gitignore` would otherwise scan on one machine and fail on another. No real pattern reaches it — a gitignore rule is a path glob and `PATH_MAX` is 4096.

A `.gitignore` that is not a regular file is no patterns, which is git's answer too: a **directory** of that name, and a **symlink** — git refuses to follow one, resolvable or not. Anything else that is not a regular file is treated the same, rather than blocking forever on a FIFO as git does.

### 3.4 Config additions

Glob patterns from `config.ignore[]` are added to Category A.

## 4. Category B: Symbol-level drop

The Symbol itself remains in the IR but is marked `dropped: true` + `dropReason`, and its fingerprint is all zeros.
Excluded from the Markdown projection; shown only via `aburi explain <symbol>`.

### 4.1 Core standard patterns

| Pattern | dropReason |
|---|---|
| class with only field declarations, no methods, no boundary decorator | `"pure DTO"` |
| interface declaration | `"interface (data model)"` |
| type alias declaration | `"type alias"` |
| empty function/method (body is `{}`) | `"empty body"` |
| re-export only (`export { X } from './y'`) | `"re-export"` |
| single-literal class (only `static` / `readonly` constant fields) | `"pure constants"` |

### 4.2 Determining "pure DTO"

A class is a `pure DTO` when all of the following hold:

- The body has no methods (including constructors; a shorthand-property constructor such as `class { constructor(public x: number) {}` is allowed)
- It has no boundary decorator (one that a framework plugin judged `boundary: true`)
- The body consists solely of field declarations

The core performs this determination, but each language plugin may add auxiliary rules for pure-DTO detection (e.g. `class-validator` decorators such as `@IsString` count as decoration; anything else is an ordinary determinant).

### 4.3 Why "interface (data model)" is dropped

An interface is a declaration expressing a data shape; it has no control flow and no effects. For Aburi's primary use case (logic diff review), its details need not be kept in the IR.

However, relationships such as "some symbol implements the `Invoice` interface" are retained in `dependencies[]` as a `Dependency` (via=`implement`). The existence of the interface itself remains discoverable.

### 4.4 Plugin additions

Language/framework plugins may add to Category B:

- `lang-typescript`: enum (?) — whether enum is treated as a data model depends on usage; make it configurable
- `framework-nestjs`: a class with only `@Module` and no body is NOT dropped (it carries a boundary, so it is outside Category B)

## 5. Category C: Node-level filter

The Symbol itself remains; specific nodes inside it are excluded from effects/calls/rules.

### 5.1 Dropping calls (call_expression)

| callee pattern | Reason |
|---|---|
| `console.{log,info,warn,error,debug,trace,table,dir,group,groupEnd}` | Logging |
| `process.stdout.write` / `process.stderr.write` | Standard output |
| `print` / `println` / `eprintln` (per language) | Language-standard logging |
| `panic` (Rust's panic is handled by a plugin) | (not included in this set) |

These appear in neither effects nor calls.

### 5.2 Plugin additions

An effect plugin may add loggers that it recognizes to Category C. Examples:
- `effects-pino`: `pino.*`, `child.*` (return value of logger.child)
- `effects-winston`: `winston.*`, `createLogger().*`
- `effects-otel`: `tracer.startSpan`, `span.setAttribute`, `metrics.counter`

If these plugins are enabled in the config, the corresponding callees are excluded from extraction.
If not enabled, they remain as ordinary calls (i.e. an in-house logger keeps appearing in `calls[]` unless something is done).

### 5.3 Dropping trivial returns

A `return` statement is **not turned into a rule** when its returned expression is any of the following:

| AST shape | Example |
|---|---|
| string/number/boolean/null/undefined literal | `return 1` / `return 'x'` / `return true` |
| identifier | `return x` |
| `this` or a member chain (arbitrary depth) | `return this.value` / `return obj.a.b.c` |
| unary operator + trivial expression | `return !x` / `return -count` |
| `void` expression | `return void 0` |

**Non-trivial returns** (included as rules):
- binary/logical operations (`return a + b`, `return x > 0`, `return a && b`)
- ternary operations (`return x ? a : b`)
- **contains** a function call combined with other expressions (`return foo() + 1`, `return [...foo(), 1]`)
- object/array literals containing spread/dynamic computation (`return { ...x, status: 'ok' }`)
- template literals with interpolation (`` return `hello ${name}` ``)
- new expressions composed with something else (`return new Foo() ?? bar`)

### 5.4 When the return is a single call_expression only

When the returned expression is **a single call**, as in `return foo()` / `return this.bar()`:

- it is **not included** as a return rule (avoids duplication)
- the call itself is recorded normally in `calls[]` (or as an effect in `effects[]`)

Thus a forward method containing `return foo()` becomes "rules: empty, calls: foo", expressing the essence of forwarding.

### 5.5 Recursive definition of triviality

```
isTrivialExpr(node):
  literal             → true
  identifier          → true
  this                → true
  member_expression   → isTrivialExpr(node.object)   # arbitrary depth
  unary_expression    → isTrivialExpr(node.argument)
  parenthesized       → isTrivialExpr(node.expression)
  otherwise           → false

isTrivialReturn(returnStatement):
  arg = returnStatement.argument
  if arg is null            → true   # return without a value
  if isTrivialExpr(arg)     → true
  if arg is call_expression → "call-only" (no Rule; the call is recorded normally)
  otherwise                 → false  # non-trivial return Rule
```

Whether a call_expression's arguments are trivial is not part of the determination (calls are recorded independently as calls, so it is unnecessary for evaluating return wrapping).

### 5.6 Dropping decorators

Aburi core does not drop decorators. Framework plugins only judge `boundary: true/false`.
Non-boundary decorators (`@deprecated`, `@experimental`, etc.) also remain in the IR (they affect the api fingerprint).

## 6. Category D: Config/Plugin extension

### 6.1 `config.suppress[]`

Identifier prefixes added to Category C (call drop):

```jsonc
{
  "suppress": ["myLogger", "metrics", "telemetry"]
}
```

This excludes `myLogger.*` / `metrics.*` / `telemetry.*` calls from effects/calls.

### 6.2 `config.keep[]`

Patterns exceptionally retained from Category C drops:

```jsonc
{
  "keep": ["@Transaction", "myCriticalLogger.audit"]
}
```

- `@<name>` form: a decorator name (the core never drops decorators, so this has weak meaning, but it is allowed for explicitness)
- `<callee>` form: exempts a call from dropping (e.g. `myCriticalLogger.audit` is the core of monitoring, so keep it)

### 6.3 Drop additions via Framework hints (Tier 3 plugin)

From the Framework hints in [`extension-vocab.md`](./extension-vocab.md) §11.3:

```jsonc
{
  "frameworkHints": [
    {
      "name": "acme-framework",
      "decorators": {
        "AcmeInternal": { "boundary": false, "drop": true }
      }
    }
  ]
}
```

Symbols decorated with `@AcmeInternal` are added to Category B.

## 7. Evaluation order

Precedence when multiple drop rules / keep rules conflict. **Higher entries win**:

```
1. config.keep                          (forced keep)
2. config.suppress                       (forced drop, but loses to keep)
3. plugin drop rules (including manifest.dropCallees)  (added to Category C/B)
4. core drop rules                       (Category A/B/C standard set)
5. default                               (no drop)
```

When an effect plugin such as `@aburi/effects-pino` declares `dropCallees: ["pino"]`, it is treated as a **level 3** plugin drop rule. Individual entries can be kept via `config.keep: ["pino.audit"]` (level 1).

Concrete examples:
- `console.log` is a core drop target (level 4) and `config.keep: ["console.log"]` is present → keep wins; it is retained
- `myLogger.info` is a drop candidate via `config.suppress: ["myLogger"]` (level 2) and `config.keep: ["myLogger.audit"]` is present → `myLogger.info` is dropped, `myLogger.audit` is retained
- Some plugin adds `panic!` as a drop target (level 3) → can be exempted via `config.keep`; the core does not touch it

## 8. Verifiable properties (test criteria)

Properties the extraction pipeline must satisfy.

### 8.1 File-level (Category A)

| ID | Input | Expected |
|---|---|---|
| A1 | scan including `node_modules/foo/bar.ts` | Does not appear in symbols; excluded from stats.totalFiles |
| A2 | scan including `*.d.ts` | Same as above |
| A3 | Files listed in `.gitignore` | Same as above (unless `respectGitignore` is off, by config or by `--no-respect-gitignore`) |
| A3b | `.gitignore` holding `assets/*` and `!assets/keep.ts` | `assets/keep.ts` is scanned; the rest of `assets/` is not |
| A3c | `.gitignore` holding `gen/` and `!gen/keep.ts` | Nothing under `gen/` is scanned — git does not descend into an excluded directory, so the negation reaches nothing |
| A3d | `packages/app/.gitignore` holding `fixtures/` | Nothing under `packages/app/fixtures/` is scanned; `packages/other/fixtures/` is untouched |
| A3e | Root `.gitignore` holding `*.ts`, `packages/app/.gitignore` holding `!keep.ts` | `packages/app/keep.ts` is scanned — the deeper file decides |
| A4 | Adding `config.ignore: ["docs/**"]` | Everything under `docs/` is skipped |

### 8.2 Symbol-level (Category B)

| ID | Input | Expected |
|---|---|---|
| B1 | pure DTO (`class Foo { x: number; y: string }`) | `dropped: true, dropReason: "pure DTO"` |
| B2 | `interface Foo { x: number }` | `dropped: true, dropReason: "interface (data model)"` |
| B3 | `type Bar = string` | `dropped: true, dropReason: "type alias"` |
| B4 | `export { x } from './y'` | `dropped: true, dropReason: "re-export"` |
| B5 | class with a boundary decorator (`@Controller`), even without methods | `dropped: false` |

### 8.3 Node-level (Category C)

| ID | Input | Expected |
|---|---|---|
| C1 | method containing `console.log(x)` | Does not appear in effects/calls |
| C2 | method containing only `return 1` | No return appears in rules |
| C3 | method containing only `return this.foo()` | No return in rules; `this.foo` in calls |
| C4 | method with `return a + b` | rules contain a return (expr: "a + b") |
| C5 | method with `return { ...x, status: 'ok' }` | rules contain a return |

### 8.4 Config/Plugin (Category D)

| ID | Input | Expected |
|---|---|---|
| D1 | `myLogger.info(x)` with `config.suppress: ["myLogger"]` | Excluded from extraction |
| D2 | `console.log(x)` with `config.keep: ["console.log"]` | Remains in calls |
| D3 | The same callee in both `config.keep` and `config.suppress` | keep wins |

### 8.5 Unit tests for the triviality determination

| ID | Input expression | Trivial? |
|---|---|---|
| T1 | `1` | yes |
| T2 | `'x'` | yes |
| T3 | `x` | yes |
| T4 | `this.x.y.z` | yes |
| T5 | `!x` | yes |
| T6 | `-this.count` | yes |
| T7 | `foo()` | call-only (no return rule, but recorded in calls) |
| T8 | `this.bar()` | call-only |
| T9 | `foo() + 1` | no |
| T10 | `x ? a : b` | no |
| T11 | `{ ...x }` | no |
| T12 | `` `hello ${name}` `` | no |

## 9. Configuration examples

Minimal configuration (defaults suffice):

```jsonc
{ "$schema": "https://aburi.dev/schema/aburi.config.v1.json" }
```

Mid-size project with custom drops:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "ignore": ["docs/**", "scripts/legacy/**"],
  "suppress": ["myLogger", "metrics", "datadog"],
  "keep": ["myLogger.audit"]
}
```

## 10. Design decisions

### 10.1 Why retain `dropped: true` instead of discarding

- Transparency: why something was dropped can be queried from the IR (`aburi explain X`)
- Reproducibility: when comparing a past IR against the current IR, dropped symbols can still be matched up
- Debugging: when drop rules change, it is easier to predict "this will enter/leave next run"

`stats.droppedSymbols` exposes the drop count, making false positives (dropping something that should have been kept) easier to discover.

### 10.2 Why file-level skips (Category A) are not `dropped: true`

Marking every symbol of a file as `dropped: true` would bloat the IR (including all of node_modules would mean hundreds of thousands of entries). Excluding them from stats as well makes it clear they are "outside Aburi's concern".

If a per-file drop history ever becomes necessary, a separate mechanism will be considered. `stats.skippedFiles[]` is not it: that array names files the scan never analysed, while a Category A drop is a deliberate exclusion from the field of view, and folding the two together would have `aburi diff` treat every ignored file as a gap in its evidence.

### 10.3 Why "pure DTO" is dropped

A DTO is a data shape and carries no business logic. During review, "did the type change?" matters, but that is a separate concern (type-change review), distinct from Aburi's primary use case.

The DTO's existence itself remains as `dropped: true`, so it does not disappear. Type-change detection will be handled by a separate future feature.

### 10.4 Why trivial returns are call-only and excluded from rules

If a return rule were emitted for a forward method like `return foo()`, the output would look redundant (foo already appears in calls). Recording it exactly once as a call keeps rules focused on meaningful branches, throws, and composite returns.

However, compositions such as `return foo() + 1` carry a distinct meaning and stay in rules.

### 10.5 The keep > suppress > plugin > core precedence

User intent always takes precedence over core/plugins. "The core drops loggers, but our in-house `auditLog.write` must stay as an audit log" is a common requirement, so keep has the highest priority.

Choices like "keep `console.log` via config.keep" are also technically allowed (e.g. projects that want to keep it for debugging).

### 10.6 Why plugin drop rules sit at the third level

Plugins hold more detailed knowledge than the core (`pino.child(...).info`), so they may decide drops ahead of the core. User configuration (config) still takes precedence over them.
