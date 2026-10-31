# What `no-match` is made of

`no-match` is the resolver's bucket for a call where nothing matched. It is the largest unresolved
bucket on most of the public repositories, and it mixes two populations: calls a syntactic rule
could settle and does not, and calls nothing settles without type information. Only the second is
what LSP enrichment is for, so this census measures the split on a hand-classified sample.
[`sample.json`](./sample.json) holds the sample, the category definitions, and the baseline every
later run is compared against.

## Result

| | Share of `no-match` (95%) | Calls, of 11,179 |
|---|---:|---:|
| A rule without types settles it | **70.1% ± 5.0%** | ≈ 7,800 |
| …and the rule yields a call edge | **4.9% ± 2.3%** | ≈ 550 (280–810) |
| Needs type information | 29.9% ± 5.0% | ≈ 3,300 |
| …and types yield a call edge | **2.0% ± 1.6%** | ≈ 220 (50–400) |

Most of `no-match` is a resolver gap, but very little of the gap is a missing edge. It is a call
put in the wrong bucket:

- **A global** of the language, the web platform or Node (`Object.keys`, `new Error()`,
  `setTimeout`), or a test runner's injected global: 35% of `no-match`. These belong in
  `external`.
- **A binding of the caller itself**, such as a local function, a destructured `setState`, or a
  `resolve` handed to a `new Promise` executor: 17%. These belong in `local-scope`, where the
  caller's own parameters already are.
- **A method on a builtin or package type** that the receiver's own declaration names
  (`const parts = []`, `new URL(…)`, `client: ws.WebSocket`): most of the 14% of declared
  receivers. These belong in `external`.

The edges a rule would add come from re-exports through barrels and `export *` (9 of 300), from a
namespace spread into an object literal (2), from a `const` merged with an interface whose Symbol
is dropped as a data model (1), and from receivers declared as workspace classes (3).

Type information settles 30% of `no-match`, but most of that is a method on a builtin or package
type (63 of 89), or a member of an interface with no body to link to (18 of 89): NestJS's
`INestApplication`, tRPC's `ProcedureBuilder`, Zod's `ZodType`. Two are `any`. Six would become
edges.

So LSP enrichment, aimed at `no-match`, would add about 220 resolved calls to the 4,349 the four
repositories resolve today. The rules above would add about 550 without it, and move about 7,300
more calls out of `no-match` into the bucket that explains them. The resolved baseline both have to
move, at the pinned commits:

| Repo | Calls | Resolved | `no-match` |
|---|---:|---:|---:|
| `hono` | 5,016 | 802 (16.0%) | 2,761 |
| `zod` | 6,535 | 1,892 (29.0%) | 2,850 |
| `trpc` | 6,256 | 847 (13.5%) | 3,110 |
| `nest` | 9,935 | 808 (8.1%) | 2,458 |

The census covers `no-match` alone. `dynamic` is a separate population: `this.` and `super.`
calls, and NestJS's constructor-injected interfaces, which make `dynamic` the largest of `nest`'s
unresolved buckets.

## Categories

A category is decided by what the callee's head is bound to, and by whether a rule that reads
syntax alone gets the call to its right outcome.

| Category | Needs types | What it is | The rule that settles it |
|---|:--:|---|---|
| `global` | no | The head names an ECMAScript, web or Node global (`Object.keys`, `new Error()`, `setTimeout`, `process.memoryUsage`, `import.meta.resolve`) that no binding in scope shadows. | Bucket a head that no scope binds and the host's global table names as `external`. |
| `test-global` | no | A test runner's global (`describe`, `it`, `expect`, `beforeEach`, `vi`) in a test file that does not import it, because the runner injects it. | In a test file, bucket an unbound runner global as `external`. |
| `local-callee` | no | A bare callee bound inside the caller: a local `const`, `let` or `function`, a destructured binding, or a parameter of a function nested in the caller. | Extend the parameter guard to every binding of the scopes that enclose the call, so the callee is bucketed `local-scope`. |
| `declared-receiver` | no | `x.m()` where the declaration of `x` states its type: `new C(…)`, a literal, or an annotation naming a type, with `\| null` at most. The binding may be local, a nested function's parameter, module-level or imported. | Look `m` up on that type: a member Symbol of a workspace class is an edge, a builtin or package type is `external`, and an interface member is `dynamic`. |
| `reexport` | no | The callee, or the namespace its head names, reaches its declaration only through a re-export: `export { x } from`, `export * from` or `export * as ns from`. | Follow re-exports from the imported module to the module that declares the name. |
| `namespace-object` | no | `z.m()` where `z` is a module-level object literal built by spreading namespace imports (`{ ..._schemas, ..._checks }`). | Read each spread namespace as a source of the object's members. |
| `merged-value` | no | `new C()` where `C` merges an interface with a `const` that holds the constructor, and the merged Symbol is dropped as a data model. | Keep a merged interface and `const` whose `const` holds a value. |
| `inferred-receiver` | yes | `x.m()` where nothing in the declaration of `x` states its type: a call's return value, a for-of variable, a destructured value, a property chain (`c.req.path.at`), or a callback parameter typed by its context. | None. Only a type checker names the type. |

`declared-receiver` stops at one declaration on purpose. Reading `x`'s own annotation or
initialiser is syntax. Reading the return type of the function that produced `x`, or the type of a
property of `x`, is type checking, and that is `inferred-receiver`. When the head of an
`inferred-receiver` is bound inside the caller, the `local-callee` rule would move the call to
`local-scope` without types, as the parameter guard does today. It still could not name the
target, so the census counts it as needing types.

Each sample also records `expected`, the outcome its category's rule gives, or the outcome type
information gives for `inferred-receiver`:

| `expected` | Meaning |
|---|---|
| `edge` | A kept Symbol is the target. |
| `external` | The language, the host or a package declares the target. |
| `local-scope` | A binding of the function that holds the call is the target. |
| `dynamic` | Only an interface or a type declares the target, or the target is a closure in an object literal, so no body is named. |
| `untyped` | The receiver is `any`, so not even types name a target. |

## Per category and repository

`node benchmarks/public-repos/census.mjs shares` prints these tables from `sample.json`.

| Category | Needs types | `hono` | `zod` | `trpc` | `nest` | All |
|---|:--:|---:|---:|---:|---:|---:|
| `global` | no | 18 | 23 | 21 | 27 | 89 |
| `test-global` | no | 14 | 0 | 2 | 1 | 17 |
| `local-callee` | no | 13 | 12 | 13 | 12 | 50 |
| `declared-receiver` | no | 18 | 11 | 7 | 7 | 43 |
| `reexport` | no | 1 | 4 | 1 | 3 | 9 |
| `namespace-object` | no | 0 | 2 | 0 | 0 | 2 |
| `merged-value` | no | 0 | 1 | 0 | 0 | 1 |
| `inferred-receiver` | yes | 11 | 22 | 31 | 25 | 89 |

| Category | edge | external | local-scope | dynamic | untyped |
|---|---:|---:|---:|---:|---:|
| `global` | 0 | 89 | 0 | 0 | 0 |
| `test-global` | 0 | 17 | 0 | 0 | 0 |
| `local-callee` | 0 | 0 | 50 | 0 | 0 |
| `declared-receiver` | 3 | 35 | 0 | 5 | 0 |
| `reexport` | 9 | 0 | 0 | 0 | 0 |
| `namespace-object` | 2 | 0 | 0 | 0 | 0 |
| `merged-value` | 1 | 0 | 0 | 0 | 0 |
| `inferred-receiver` | 6 | 63 | 0 | 18 | 2 |

| Share of no-match | `hono` (n=75) | `zod` (n=75) | `trpc` (n=75) | `nest` (n=75) | All, weighted by no-match |
|---|---:|---:|---:|---:|---:|
| Resolver gap: a rule without types settles it | 85% (76%–92%) | 71% (60%–80%) | 59% (47%–69%) | 67% (55%–76%) | 70.1% ± 5.0% |
| …and the rule yields a call edge | 1% (0%–7%) | 11% (6%–20%) | 1% (0%–7%) | 7% (3%–15%) | 4.9% ± 2.3% |
| Needs type information | 15% (8%–24%) | 29% (20%–40%) | 41% (31%–53%) | 33% (24%–45%) | 29.9% ± 5.0% |
| …and types yield a call edge | 1% (0%–7%) | 4% (1%–11%) | 1% (0%–7%) | 1% (0%–7%) | 2.0% ± 1.6% |

| Files | Samples | Resolver gap | Needs types |
|---|---:|---:|---:|
| Test files | 61 | 46 (75%) | 15 (25%) |
| Other files | 239 | 165 (69%) | 74 (31%) |

The repositories differ in the way their shapes predict. `hono` runs vitest with injected globals
(14 of its 75), so its test code is mostly a resolver gap. `trpc` reaches most of its own API
through proxies and builders whose types are inferred (31 of 75). `zod` declares its schemas as an
interface and a `const` of one name, and gathers them through `export *` and namespace spreads, so
it has the merge, both spreads and four of the nine re-exports. Test code is a different population from the
rest, as expected: it holds every `test-global`, and in the other files the gap is 69% rather than
75%.

## How the sample was drawn

- **Frame.** Every call the resolver buckets `no-match` at the commits `repos.json` pins, scanned
  with the Aburi commit `sample.json` records: 2,761 in `hono`, 2,850 in `zod`, 3,110 in `trpc` and
  2,458 in `nest`. The four differ in shape: a web framework with a JSX runtime and injected test
  globals, a schema library of merged declarations and barrels, a client and server monorepo
  typed through proxies, and a dependency-injection framework built on decorators.
- **Draw.** 75 calls per repository, without replacement, from a pseudo-random sequence seeded with
  `no-match:<repo>`, so a draw at the same pins and commit picks the same calls. At an even split,
  75 gives each repository a 95% interval of about ±11 points and the pooled estimate about ±5.6.
  That decides a majority without claiming precision per repository.
- **Estimate.** Each repository is a stratum, weighted by its `no-match` count, with the
  finite-population correction for a draw without replacement. The per-repository intervals are
  Wilson intervals.
- **Unit.** The unit is the call site, so a long function weighs in proportion to its calls:
  `hono`'s 1,100-line router test table holds 22 of its 75, and `zod`'s locale files, one per
language and alike, 11 of its.
  The shares are shares of call sites, and that is what the resolver's counters count.
- **Evidence.** Each call was read in its file. The head's binding came from the TypeScript
  compiler's binder over the clone, and the callee's declaration from its checker. The clones have
  no `node_modules`, so for a package type the expected outcome was decided by reading the code.
  The `note` field explains every call whose category or outcome is not plain from the code.

## Comparing a later run

```bash
pnpm build
node benchmarks/public-repos/run.mjs --only zod,hono,trpc,nest --runs 1 --warmup 0 --no-diff
node benchmarks/public-repos/census.mjs check
```

`check` scans the four clones with the built CLI and tabulates, per category, what the resolver
makes of each sampled call now, and how many land where `expected` says they should (`resolved`
for an `edge`, and `no-match` for an `untyped` receiver, which nothing can resolve). A call whose
symbol, line or target no longer matches is `gone`. It refuses a clone that is not at the pin the
sample was drawn at, since the calls are not comparable across pins. At the commit the sample was
drawn at, every call is still `no-match`.

`census.mjs draw` draws a fresh sample, with its categories empty for classifying by hand. It is
for when `repos.json` moves a pin. `--only`, `--per-repo` and `--seed` change the frame, and
`--work-dir` is where `run.mjs` keeps its clones for both `draw` and `check`.
