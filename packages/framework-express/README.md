# @aburi/framework-express

Express framework plugin for `@aburi/core`. Classifies Router instances, HTTP
route handlers, middleware, error-handling middleware, and sub-router mount
points into `framework:express:*` extKinds so downstream tooling can group them
in the workspace projection.

Recognised shapes:

| Source shape | `extKind` | Signal |
|---|---|---|
| `const r = Router()` / `const r = express.Router()` | `framework:express:router` | Router factory call bound to a const |
| `app.get('/users', h)` / `router.post(…)` | `framework:express:route` | member call whose leaf is `get`/`post`/`put`/`patch`/`delete`/`all` |
| `app.use((req, res, next) => …)` | `framework:express:middleware` | `.use(…)` with an arity-3 inline handler |
| `app.use(logger)` | `framework:express:middleware` | `.use(…)` with an out-of-scope identifier argument (confidence: `medium`) |
| `app.use((err, req, res, next) => …)` | `framework:express:error-middleware` | `.use(…)` with an arity-4 handler |
| `app.use('/api', router)` | `framework:express:mount` | `.use(pathLiteral, identifier)` two-arg shape |

Priorities inside `.use(...)` are first-match-wins in the order above: an
arity-4 handler always wins over any other shape, then the two-arg
`(path, identifier)` mount pattern, then plain middleware.

Confidence is `high` when the file imports the `express` package (or reaches
Express via CommonJS `require('express')`) and `medium` otherwise — the
classification survives so the workspace projection still surfaces the shape,
but consumers can treat medium-confidence rows as candidates for review.

Not classified today (documented for completeness):

- Route handlers defined as separate declarations
  (`function getUsers(req, res) {…}`) — Aburi's Symbol extractor cannot see the
  call-site linkage without cross-symbol lookup, so these remain plain
  `function` Symbols. The `app.get('/users', getUsers)` call itself IS
  classified via the promoted `kind: "call"` Symbol.
- Type-level inferences (whether a `Handler` typed function argument is an
  Express handler). The arity heuristic used here is the most reliable
  pre-LSP signal for a middleware / error-middleware split.

## Install

```bash
pnpm add @aburi/framework-express
```

## Usage

```ts
import { expressFrameworkPlugin } from "@aburi/framework-express"
```

The plugin's `provides.frameworks: ["express"]` matches `@aburi/core`'s
Component autodetect against a workspace `express` npm dependency. Adding
`"@aburi/framework-express"` to `aburi.json`'s `frameworks` array wires it into
the scan pipeline.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) §5.2 — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:express:*`) plug into the shared vocab.
- [`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md) — plugin authoring walkthrough with cross-references to this package's tests.
