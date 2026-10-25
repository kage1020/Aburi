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

**Symlinks are not followed, to a file or to a directory.** Git stores a link as one entry and never looks behind it, and the walk goes no further: a link is never a candidate for extraction, and nothing under a linked directory is reached through it. Followed, a link gives a file one Symbol id per path reaching it (`shared -> src` lists every file twice) and brings in files from outside the workspace under a workspace path, and a cyclic link is expanded once. Component detection's language census and its nx project search make the same decision, so neither finds anything only a link reaches; its resolution of declared package patterns follows links, as pnpm does, so a package declared through a link is a Component that owns no scanned file ([`component-detect.md` §3.1.1](./component-detect.md)).

**A name that starts with a dot excludes nothing by itself.** Git tracks a dot directory like any other, and source lives in them: a GitHub Action under `.github/actions/<name>/src`, Storybook's configuration in `.storybook`, a VitePress theme in `docs/.vitepress`. So a leading dot alone keeps no directory out, and a dot file is a candidate like any other. What must stay out is git's own store (below) and what §3.1 names — Yarn's files and VitePress's cache, beside the framework caches — and what else such a directory holds is decided by `.gitignore`, as everywhere else in the tree (§10.7). The globs read a leading dot as an ordinary character: `*` and `**` in a core pattern, in `config.ignore[]` or in a language plugin's drop list match `.vitepress` as they match `src`, so `docs/**` leaves out `docs/.vitepress/` too. Component detection's language census and its nx project search walk dot directories as well; its resolution of declared package patterns reads them as pnpm and npm do, where a wildcard does not match a leading dot and a pattern that spells one reaches it ([`component-detect.md` §3.1.1](./component-detect.md)).

**Git's own store is never listed, and another checkout is not walked.** Every walk drops a `.git` from the listing of the directory that holds it, whatever the globs spell, so nothing in a repository's store is a candidate. A directory below the workspace root that holds a `.git` — a directory, or a file opening with `gitdir:`, the pointer a linked worktree or a submodule keeps in its place — is another checkout, and the walk lists nothing in it: git lists such a directory as one entry, never its files as the outer checkout's. A linked worktree kept in the main checkout (`.worktrees/feat`, `.claude/worktrees/feat`), a nested repository, a populated submodule and the base worktree `aburi diff` creates under an in-repository `TMPDIR` are each scanned from their own root, never as part of the checkout around them (§10.8). A `.git` file that is not such a pointer marks nothing, and its directory is walked; one the walk cannot read ends the run as a directory it cannot list does, naming the directory that holds it. Component detection's language census and its nx project search pass over another checkout too; its resolution of declared package patterns walks into one, as pnpm and npm do, and drops only the `.git` ([`component-detect.md` §8](./component-detect.md)).

**A directory the walk cannot list ends the run**, naming it, at exit `1` — the code a file the scan cannot open ends it with ([`cli-spec.md`](./cli-spec.md) §5.4), and by the same predicate. A directory gone by the time the walk reaches it (`ENOENT`, or `ENOTDIR` when a file replaced it) is passed over, as a vanished file is; any other failure ends the run, apart from the exemptions below. A permission (`EACCES`, or `EPERM` where Windows denies one), an exhausted descriptor table or failing storage is a property of the machine: passed over, it would leave every file under the directory out of `symbols`, `stats.totalFiles` and `stats.skippedFiles` alike, and the same commit would give a smaller Document on another day and still exit `0`. So is an entry that vanishes while its directory is listed, on a filesystem that reports no entry types: the listing fails with the entry's `ENOENT`, and passing it over would lose the entry's siblings with it. `ELOOP` from a listing ends the run too: the walk lists no link, so only the machine can cause it. When several directories fail, the first in path order, by code unit, is the one named. Two kinds of directory are exempt, for different reasons. One the walk never lists cannot fail to be listed: one the Category A globs drop, a `.git`, and any directory inside another checkout. A dot directory is not one of them: a container's `.pgdata/` is listed like any other. One that `.gitignore` excludes is still walked (§3.3), but while `.gitignore` is respected none of its files can reach the Document, and git never lists it either, so failing to list it — a data volume a container left in the checkout, owned by another user — is passed over, and the error for any other directory suggests excluding it there. A rule has to exclude the directory itself or one above it: `data/pg/*` excludes what is in `data/pg` and not `data/pg`, so failing to list `data/pg` still ends the run, as it must, because a later `!` rule could re-include a file in it. With `respectGitignore` off its files are scanned, and failing to list it ends the run like any other. Component detection's language census and its nx project search decide the same way; its resolution of declared package patterns never reads `.gitignore`, and a link it cannot resolve ends the run as a directory it cannot list does ([`component-detect.md` §8](./component-detect.md)).

### 3.1 Core standard patterns

| Pattern | Reason |
|---|---|
| `**/node_modules/**` | Dependency libraries |
| `**/.yarn/**` `**/.pnp.cjs` `**/.pnp.loader.mjs` | Yarn's own files: the release, plugins and editor SDKs its recommended `.gitignore` keeps committed, and the Plug'n'Play loader it generates |
| `**/dist/**` `**/build/**` `**/out/**` `**/target/**` | Build artifacts |
| `**/.next/**` `**/.nuxt/**` `**/.svelte-kit/**` `**/.output/**` | Framework build caches |
| `**/.vitepress/cache/**` | VitePress's dependency cache: generated JavaScript that `vitepress init` leaves out of `.gitignore` |
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

It is decided the way git decides it, which is not the same as adding its lines to the Category A glob list. Git's rules pull in opposite directions — a later `!rule` re-includes a file, and *nothing* re-includes a file under a directory that was excluded outright, because git never descends into it — and a glob list can express neither. So each file is compiled into its own matcher and every discovered candidate is asked about the chain of them above it, rather than the walk being pruned by any. The consequence worth knowing: a `.gitignore`d directory is still walked, and one that cannot be listed is passed over rather than ending the run (§3). What such a file usually names is in the Category A list above and is pruned there. Each matcher is asked about the candidate alone: whether a directory above it is excluded is decided first, across every file at once, so a deeper file that re-includes a directory (`third_party/.gitignore` holding `!ourlib/` under a root `third_party/*`) brings back the files in it.

The matcher is a port of git's wildmatch, not a library's reading of the documentation: which lines are rules (a leading byte-order mark, one CR before each newline and unescaped trailing spaces are dropped, a NUL ends a rule, and a lone `!` is a rule that matches nothing), what each is matched against, and the glob itself (`**`, POSIX classes such as `[[:digit:]]`, `\?`, a `]` as a bracket's first member, reversed ranges) follow git's `dir.c` and `wildmatch.c`. No local git is consulted, so where git's answer has changed between releases, the current one is followed. Matching is on bytes, as git's is, so `?` takes one byte of a UTF-8 name rather than one character. A rule git reads but can never match, such as one with an unterminated bracket, matches nothing here too and is not an error. One search git makes is cut short: once what follows a `**/` has failed in a way no deeper directory can mend, no deeper directory is tried. That changes what a rule costs, never its answer; git's own time grows exponentially with the number of `**/` in a rule. Beyond that, the port is git's matcher apart from the differences the rest of this section lists: case, tracked files, the rule files outside the tree, rules over 4,096 bytes, and rule files of 100 MiB or more.

**The Category A globs are outside a negation's reach.** The core patterns, `config.ignore[]` (§3.4) and language-plugin drop patterns prune the walk, and no `!` line in `.gitignore` brings back a file they excluded — those are not gitignore rules and the matcher never sees the candidate.

Matching is case-sensitive, whatever the filesystem is. Git folds case only where `core.ignoreCase` says so, so no single answer agrees with git on every platform; folding would drop a file git keeps wherever git is case-sensitive, which is the failure this mechanism exists to prevent. Reading `core.ignoreCase` would settle it and is refused for a different reason — it would make the Document depend on the machine's git configuration.

One thing "the way git decides it" does not cover: git applies `.gitignore` to untracked files only, so a tracked file matching a rule is not ignored. There is no index here, so such a file is excluded.

**Every directory's file, not just the root's.** Git consults a `.gitignore` in each directory from the repository root down to the file's own, and a deeper file's rules override a shallower one's — `packages/app/.gitignore` holding `fixtures/` is the ordinary way to say a package's fixtures are not source. Precedence is per directory rather than per line: two files that disagree about one path are decided by which is deeper, whichever direction each points. A nested file's patterns are relative to its own directory, so `/local.ts` in `packages/app` anchors to `packages/app/local.ts`.

The directory rule above still holds across files: nothing re-includes a file under a directory that was excluded, so a root `gen/` cannot be undone by `gen/.gitignore` holding `!keep.ts`. A root `gen/*` can, because it never excluded the directory.

**Not read**, and not by accident: `$GIT_DIR/info/exclude` and `core.excludesFile`. Both live outside the tree and are per-machine, so honouring them would make the Document depend on who ran the scan — the determinism [`ir-schema.md`](./ir-schema.md) §1 exists to defend. A `.gitignore` is committed, so every clone answers the same. `.git/.gitignore` is not a rule file to git and is not one here.

A rule file is opened by descending to it, as git finds it — so one under a directory that has no surviving candidate is never opened at all. That covers a directory the Category A globs dropped, a directory an outer `.gitignore` excluded, and `.git` itself. It is not only that such a file's rules would be inert; an unusable one would otherwise end a run git would not even have opened it during.

A rule longer than 4,096 bytes is refused with the file and the line named. That is a determinism rule, not a style one: each `*` can take the matcher one call deeper, where the stack runs out depends on the machine and the runtime, and without a fixed cap the same `.gitignore` would scan on one machine and fail on another. No real pattern reaches it — a gitignore rule is a path glob, and 4096 is `PATH_MAX` on the platform that allows the longest one.

A `.gitignore` of 100 MiB or more is refused too, before it is read, with the file named. Git skips such a file with a warning and reads no rules from it. Carrying on without a word would scan whatever the file excludes, so the run ends here instead.

A `.gitignore` that is not a regular file is no patterns, which is git's answer too: a **directory** of that name, and a **symlink** — git refuses to follow one, resolvable or not. Anything else that is not a regular file is treated the same, rather than blocking forever on a FIFO as git does.

### 3.4 Config additions

Glob patterns from `config.ignore[]` are added to Category A.

## 4. Category B: Symbol-level drop

The Symbol itself remains in the IR but is marked `dropped: true` + `dropReason`, and its fingerprint is all zeros.
Excluded from the Markdown projection; shown only via `aburi explain <symbol>`.

### 4.1 Core standard patterns

| Pattern | dropReason |
|---|---|
| class with only field declarations, no methods or static blocks, no boundary decorator | `"pure DTO"` |
| interface declaration | `"interface (data model)"` |
| type alias declaration | `"type alias"` |
| empty function/method (body is `{}`) | `"empty body"` |
| re-export only (`export { X } from './y'`) | `"re-export"` |
| single-literal class (only `static` / `readonly` constant fields) | `"pure constants"` |

### 4.2 Determining "pure DTO"

A class is a `pure DTO` when all of the following hold:

- The body has no methods, constructors included (even one that only declares parameter properties, such as `constructor(public x: number) {}`), and no `static { … }` block
- It has no boundary decorator (one that a framework plugin judged `boundary: true`)
- The body declares at least one field, and every other member is an index signature or a comment

A static block is behaviour, more plainly than a method: it runs, unconditionally, when the class is defined. Its calls are walked on the class (`lang-plugin.md` LP20a), the only Symbol that carries them, so dropping a class of fields and a static block as a DTO would take the block's calls and effects with it. Getters, setters and constructors are methods here, and so are a method signature and an abstract method, which declare behaviour without a body.

An index signature (`[key: string]: unknown`) is part of the shape, so it leaves a class of fields a DTO. A `//` or `/* */` comment is not a member at all and changes neither hint: a class of `static readonly` literals with a doc comment on each is still `pure constants`. An index signature is not a constant, so beside one that class is a `pure DTO`.

A field whose value is a function *the plugin recognises as one* is a method for this rule (`create = (d) => { … }`, `create = function (d) { … }`). It declares behaviour, not a shape, and a class written entirely that way is not a data model. The question is the field's value, not whether the member became a Symbol: a member the plugin could not name — a computed name, say — is still not data.

The recognised set is the language plugin's, and it is narrower than "holds a function": a generator, or a function behind a wrapper (`handle = withAuth(() => …)`), reads as data here. A class of nothing else is dropped, and the calls the owner was carrying for it go with it, which is a loss rather than a filter. Widening the set is one decision for the plugin and not three, since the same predicate decides whether the member gets a Symbol at all.

Being such a function is the only way a field's value keeps the class. Any other initializer, a call included (`seed = makeSeed()`, `static rows = db.load()`), leaves the member a field declaration, although it runs on construction or definition and is walked on the class: a class of such fields is a DTO, and those calls go with it, the same loss as the wrapper's.

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
| `this`, `super` or a member chain (arbitrary depth) | `return this.value` / `return obj.a.b.c` |
| bracket access with a trivial object and a trivial index | `return items[0]` / `return map[key]` |
| unary or update operator + trivial expression | `return !x` / `return -count` |
| `void` expression | `return void 0` |

**Non-trivial returns** (included as rules):
- binary/logical operations (`return a + b`, `return x > 0`, `return a && b`)
- ternary operations (`return x ? a : b`)
- **contains** a function call combined with other expressions (`return foo() + 1`, `return [...foo(), 1]`)
- object/array literals containing spread/dynamic computation (`return { ...x, status: 'ok' }`)
- template literals with interpolation (`` return `hello ${name}` ``)
- new expressions composed with something else (`return new Foo() ?? bar`)
- bracket access with a non-trivial index (`return cache[computeKey(k)]`, `return LABELS[await count()]`) — a type-level wrapper around the index is read through, so `return obj[key as keyof T]` stays trivial (§5.5)

An arrow that is a Symbol's walk root has its expression body read as its returned value, so it goes through the same determination as `return <expr>`: `(u) => u.role === "admin"` gets the `return` rule `function f(u) { return u.role === "admin" }` gets, `(id) => fetchUser(id)` gets none and records the call (§5.4), and `(u) => u.role` gets none (§5.5). An arrow written inside another body, such as the callback in `return xs.map((x) => x * 2)`, is not a walk root: its expression body adds no rule to the enclosing Symbol, where a block-bodied callback's `return` does. A function a `const` hands its initializer's call is one (`lang-plugin.md` LP7c), so `export const doubled = xs.map((x) => x * 2)` gets `return: x * 2`, as its block spelling does. So is a property holding an arrow in a binding's object literal (LP7d): `const can = { admin: (u) => u.role === "admin" }` gives `can.admin` that `return` rule. One pair of parentheses around the body is not part of `expr` — the grammar requires them around an object literal (`() => ({ a: 1 })`), and the block spelling `return { a: 1 }` has nothing to match them. The rule's `line` is the body's first line — the opening parenthesis's when the body is parenthesized — not a `return` keyword's.

### 5.4 When the return is a single call only

When the returned expression is **a single call**, as in `return foo()` / `return this.bar()` / `return new Foo()`:

- it is **not included** as a return rule (avoids duplication)
- the call itself is recorded normally in `calls[]` (or as an effect in `effects[]`)

Thus a forward method containing `return foo()` becomes "rules: empty, calls: foo", expressing the essence of forwarding.

### 5.5 Recursive definition of triviality

```
isTrivialExpr(node):
  literal              → true
  identifier           → true
  this                 → true
  super                → true
  member_expression    → isTrivialExpr(node.object)   # arbitrary depth
  subscript_expression → isTrivialExpr(node.object) and isTrivialExpr(unwrapType(node.index))
  unary_expression     → isTrivialExpr(node.argument)
  update_expression    → isTrivialExpr(node.argument)
  parenthesized        → isTrivialExpr(node.expression)
  otherwise            → false

unwrapType(index):     # an index only, never the returned expression itself
  while index is as / satisfies / non-null (!) / <T> / parenthesized → index = its expression
  return index

isTrivialReturn(returnStatement):
  arg = returnStatement.argument
  if arg is null            → true   # return without a value
  if isTrivialExpr(arg)     → true
  if arg is call_expression or new_expression → "call-only" (no Rule; the call is recorded normally)
  otherwise                 → false  # non-trivial return Rule
```

A type-level wrapper asserts something about the index without replacing it, so `a[i as number]`, `a[i!]`, `a[<number>i]`, `a[k satisfies string]` and `obj[key as keyof T]` are read as `a[i]`, `a[k]` and `obj[key]` are. Only an index is read through one: `isTrivialExpr` has no case for a wrapper, so `return x as T` is a rule. A template literal is not a `literal`, with or without a substitution, so `` return `k` `` is a rule and so is `` return a[`k`] ``, where `return a['k']` is trivial. An index that updates a name is read as the update is at the top, so `return a[i++]` is trivial, as `return i++` is.

Whether a call_expression's arguments are trivial is not part of the determination (calls are recorded independently as calls, so it is unnecessary for evaluating return wrapping). A call-only return is walked, so its arguments' calls are recorded whatever they are; a trivial return is not walked at all. That is why the index is part of the determination: a property is a name, but an index is an expression and can hold a call, and `return cache[computeKey(k)]` read as trivial would record no `computeKey` in any Symbol.

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

Symbols decorated with `@AcmeInternal` are added to Category B, with the `dropReason` `frameworkHints "acme-framework": @AcmeInternal`.
A `classNamePatterns` rule with `drop: true` does the same for the classes it matches.

The hint reaches the pipeline as the framework plugin's `symbolDropHint`. Every framework plugin is asked, whichever of them classified the Symbol, after the core rules (§4.1) and before the language plugin's hint, and the first answer is the drop. A Symbol with a boundary decorator is kept, as it is from every other Category-B rule.

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
| A3f | Root `.gitignore` holding `third_party/*`, `third_party/.gitignore` holding `!ourlib/` | `third_party/ourlib/index.ts` is scanned; `third_party/other/x.ts` is not — the deeper file re-includes the directory, and the root's rule says nothing about the file itself |
| A3g | `.gitignore` holding `src/**/`; then `*` and a lone `!`; then `a[[:digit:]].ts`, `q\?.ts` and `a[]].ts` | `src/a.ts` is scanned and `src/sub/c.ts` is not; nothing is scanned; `a1.ts`, `q?.ts` and `a].ts` are not scanned and `qx.ts` is — each as `git ls-files -o --exclude-standard` lists them |
| A3h | `.gitignore` holding a rule git can never match (`a/[/b`, an unterminated bracket) beside `src/b.ts` | The scan runs; `src/a.ts` is scanned and `src/b.ts` is not |
| A4 | Adding `config.ignore: ["docs/**"]` | Everything under `docs/` is skipped, `docs/.vitepress/` included |
| A5 | `src/a.ts` beside the directory links `shared -> src`, `src/ext` linking out of the workspace and `src/loop -> ..`, and the file links `src/b.ts -> a.ts`, `src/o.ts` linking to a file outside the workspace and the dangling `src/dangling.ts -> nowhere.ts` | Only `src/a.ts` is scanned, once, and nothing is skipped: no link is a candidate and nothing is reached through one |
| A5b | `src/a.ts` in a workspace whose root is itself reached through a link | `src/a.ts` is scanned, as it is from the root's real path: the rule is about links inside the workspace, not the path to it |
| A6 | A directory `src/locked` or `.config/locked` that cannot be listed — `EACCES`, `EPERM`, `EIO`, `EMFILE` or `ELOOP` — or a workspace root that cannot be, whatever `.gitignore` says | The run ends with `scan-directory-unreadable` naming the directory, at exit `1`; of several, the first in path order |
| A6b | `src/gone` failing with `ENOENT` or `ENOTDIR` when listed | Passed over: the rest of `src/` is scanned and nothing is skipped. An entry of `src/gen` whose type lookup fails with `ENOENT` while `src/gen` is listed ends the run as in A6, naming `src/gen` |
| A6c | `data/pg` that cannot be listed, with `.gitignore` holding `pg/` or `data/`, or `data/.gitignore` holding `pg/` | Passed over while `.gitignore` is respected, and an unlistable `src/locked` beside it is still named; with `respectGitignore` off the run ends as in A6. With `.gitignore` holding `data/pg/*`, or `data/*` with `data/.gitignore` holding `!pg/`, the run ends as in A6 |
| A6d | `build/`, `config.ignore: ["fixtures/**"]` and a language plugin's `**/legacy/**`, each a directory that cannot be listed | None of them is listed, and the run is unaffected |
| A6e | `.git/` and a nested repository's `libs/vendored/.git/`, both directories that cannot be listed | Neither is listed, and the run is unaffected |
| A7 | `.github/actions/deploy/src/main.ts`, `.storybook/main.ts`, `docs/.vitepress/config.ts` and `.commitlintrc.ts` beside `src/a.ts` | All five are scanned: a Symbol there is named by its path like any other (`ts:.storybook/main.ts#config`), and the file counts in `stats.totalFiles` |
| A7b | `.git/HEAD`, `.git/hooks/pre-commit.ts`, `libs/vendored/.git/config`, a `.git` file at `libs/sub/.git`, `.yarn/releases/yarn-4.5.0.cjs`, `.yarn/sdks/typescript/lib/tsserver.js`, `.pnp.cjs` and `.pnp.loader.mjs`, with no extension filter | None is scanned |
| A7c | `.storybook/env.d.ts`, `.github/actions/deploy/dist/index.ts`, `docs/.vitepress/config.ts` under `config.ignore: ["docs/**"]`, `.config/setup.ts` under `config.ignore: ["*/setup.ts"]`, and `.config/legacy/a.ts` under a language plugin's `**/legacy/**` | None is scanned, and `.storybook/main.ts` beside them is: every drop glob's `*` and `**` match a name that starts with a dot |
| A7d | `.next/`, `.nuxt/`, `.svelte-kit/`, `.output/`, `docs/.vitepress/cache/` and `.venv/` each holding a file, with no extension filter | None is scanned: a core pattern names each |
| A7e | `src/one.ts` in `.claude/worktrees/feat`, `worktrees/feat` and `libs/sub`, each beside a `.git` file opening with `gitdir:`, and in `libs/vendored`, beside a `.git` directory | None is scanned, and `src/keep.ts` at the root is: each directory is another checkout. `libs/plain/a.ts` beside a `.git` file that is not a `gitdir:` pointer is scanned |
| A7f | `libs/sealed/.git` a file the walk cannot read | The run ends with `scan-directory-unreadable` naming `libs/sealed`, at exit `1` |

### 8.2 Symbol-level (Category B)

| ID | Input | Expected |
|---|---|---|
| B1 | pure DTO (`class Foo { x: number; y: string }`) | `dropped: true, dropReason: "pure DTO"` |
| B1b | a class of a field and a static block (`class Registry { static items: string[] = []; static { prisma.user.deleteMany() } }`), and the same class without the field | `dropped: false` with `prisma.user.deleteMany` in the class's `calls`, either way; without the block, `dropped: true, dropReason: "pure DTO"` |
| B1c | a class of a field and a getter, a setter or a constructor | `dropped: false` |
| B1d | a class of a field and an index signature, a `declare` field, an `accessor` field, a field holding a call (`seed = compute()`) or a comment | `dropped: true, dropReason: "pure DTO"` |
| B1e | a class of `static readonly` literals with a doc comment, a line comment or a stray `;` among them; the same class beside an index signature | `dropped: true, dropReason: "pure constants"`; beside the index signature, `"pure DTO"` |
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
| C6 | an arrow that is a walk root with an expression body — `export const f = (a, b) => a + b`, `export const f = () => ({ ...x, status: 'ok' })`, `export const f = (id) => fetchUser(id)` | what C4 / C5 / C3 give the block spelling: a return (expr: "a + b"), a return (expr: "{ ...x, status: 'ok' }"), no return and `fetchUser` in calls |

### 8.4 Config/Plugin (Category D)

| ID | Input | Expected |
|---|---|---|
| D1 | `myLogger.info(x)` with `config.suppress: ["myLogger"]` | Excluded from extraction |
| D2 | `console.log(x)` with `config.keep: ["console.log"]` | Remains in calls |
| D3 | The same callee in both `config.keep` and `config.suppress` | keep wins |
| D4 | A class decorated `@AcmeInternal()` with the §6.3 hint | `dropped: true`, `dropReason: "frameworkHints \"acme-framework\": @AcmeInternal"` |
| D5 | The same class also carrying a boundary decorator | `dropped: false` |

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
| T13 | `items[0]` | yes |
| T14 | `map[key]` | yes |
| T15 | `cache[computeKey(k)]` | no |
| T16 | `obj[key as keyof T]` | yes |
| T17 | `key as keyof T` | no |
| T18 | `` a[`k`] `` | no |
| T19 | `a[i++]` | yes |

## 9. Configuration examples

Minimal configuration (defaults suffice):

```jsonc
{ "$schema": "https://aburi.kage1020.com/schema/aburi.config.v1.json" }
```

Mid-size project with custom drops:

```jsonc
{
  "$schema": "https://aburi.kage1020.com/schema/aburi.config.v1.json",
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

### 10.7 Why dot directories are walked, and which are named

Discovery once took no file with a path segment that starts with a dot. That kept `.git` out, and with it every tracked file under `.github/actions/<name>/src`, `.storybook` or `docs/.vitepress`, without a word: no Symbol, no place in `stats.totalFiles`, no `stats.skippedFiles` entry, and since `config.ignore[]` can only remove files, no way to bring them back. Git gives a leading dot no meaning, and neither does its matcher, so the rule is now git's: such a name is walked like any other, and git's own store is kept out by name (§3).

A tool's directory earns its own pattern when the tool's own setup leaves it out of `.gitignore`, and it holds files a language plugin claims that are not the project's source. Yarn's files meet both. Its recommended `.gitignore` keeps the release, plugins and editor SDKs in `.yarn/` committed, and a release is over the default `maxFileSizeBytes` (Yarn 4.18's is 3.8 MB), so without the pattern every such repository's Document would name it in `stats.skippedFiles` and every diff would list it among the files not compared; under zero-installs `.pnp.cjs` and `.pnp.loader.mjs` are committed too, Yarn's runtime regenerated on every install. So does VitePress's `.vitepress/cache`: its Getting Started asks the project to add it to `.gitignore` and `vitepress init` writes none, so a project that skips that step keeps the dependency cache's generated JavaScript in the tree, while `.vitepress/dist` is `**/dist/**` already. Nothing else is named. `.turbo`, `.idea`, `.vscode` and a pnpm store inside the workspace hold nothing a plugin claims, so walking them costs time, not output; `.gitignore` decides which files reach the Document without pruning the walk (§3.3), so the same holds for a git-ignored store. `.cache`, `.nx/cache`, `.angular/cache` and `.docusaurus` do hold JavaScript, but the tools that write them put them in `.gitignore`, which is what keeps a project's generated directories out; `config.ignore[]` covers a project that commits one.

### 10.8 Why another checkout is not walked

A directory below the workspace root that holds a `.git` is a checkout of its own, and git treats it so: `git status` lists it as one entry, and none of its files is the outer commit's. Walking into it read files the outer commit does not hold. Three layouts put one there, the three the workspace-root walk stops at ([`component-detect.md` §11.1](./component-detect.md)): a linked worktree kept inside the main checkout, a nested repository or a submodule, and the base worktree `aburi diff` creates under an in-repository `TMPDIR`, which it keeps while it scans the head. Once dot directories were walked (§10.7), the first and the last came in from where they usually sit: with a worktree at `.claude/worktrees/feat`, `aburi diff HEAD..HEAD` in the main checkout reported that worktree's Symbols as added, and an nx project in it became a second Component. `.gitignore` could not be counted on to keep them out: Claude Code keeps worktrees in `.claude/worktrees/` without adding it there, and `.git/info/exclude` is not read (§3.3).

So the walk stops where git stops. A submodule or a vendored clone that keeps its `.git` is scanned from its own root and not from the repository around it, which is what `aburi diff` already did with submodules: it leaves them out of both file scans ([`cli-spec.md`](./cli-spec.md) §6.4.1). The resolution of declared package patterns is the exception, because it stands for pnpm and npm, which walk into a nested checkout: a package declared there is still a candidate.
