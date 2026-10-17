# @aburi/framework-express

Express framework plugin for `@aburi/core`. Classifies Router instances, HTTP
route handlers, middleware, error-handling middleware, and sub-router mount
points into `framework:express:*` extKinds so downstream tooling can group them
in the workspace projection.

Recognised shapes:

| Source shape | `extKind` | Signal |
|---|---|---|
| `const r = Router()` / `const r = express.Router()` | `framework:express:router` | Router factory call bound to that const's own declarator; in `const a = 1, r = Router()` only `r` |
| `app.get('/users', h)` / `router.post(…)` | `framework:express:route` | member call whose leaf is `get`/`post`/`put`/`patch`/`delete`/`all` and handed a handler after its path |
| `app.use((req, res, next) => …)` | `framework:express:middleware` | `.use(…)` with an arity-3 inline handler |
| `app.use(logger)` | `framework:express:middleware` | `.use(…)` with an out-of-scope identifier argument (confidence: `medium`) |
| `app.use((err, req, res, next) => …)` | `framework:express:error-middleware` | `.use(…)` with an arity-4 handler |
| `app.use('/api', router)` | `framework:express:mount` | `.use(pathLiteral, identifier)` two-arg shape |

Priorities inside `.use(...)` are first-match-wins in the order above: an
arity-4 handler always wins over any other shape, then the two-arg
`(path, identifier)` mount pattern, then plain middleware.

A route method's name is shared vocabulary (`map.delete(key)`,
`settings.get("port")`, Express's own settings getter `app.get("env")`), so a
call is a route only when its arguments have a registration's shape. The first
argument is taken as the path, and its shape is not checked, so
`app.get(ROUTES.users, h)` is a route. At least one argument after it must be
handler-shaped: an inline function, an identifier, a member path (`users.list`,
`handlers["list"]`), a call (`asyncHandler(h)`,
`passport.authenticate("local")`), a choice between those
(`isProd ? cached : live`, `custom || fallback`, `options.handler ?? fallback`),
or an array or spread of them. Data in the handler's place does not count, so
`axios.post(url, { id })` is not a route, but an identifier can name data as
well as a function, so `cache.put(key, value)` is one. Two shapes have no path
to skip, and a handler alone makes them a route: a chain that has called
`.route(path)` with a literal path beginning with `/`, on any receiver and at
any depth (`app.route("/users").get(listUsers).post(createUser)`), and a call
whose first argument is a spread (`app.get(...routeArgs)`).

Arguments are read through `as`, `satisfies`, `!` and parentheses, and so is a
route's receiver chain, as `@aburi/lang-typescript` reads them to name the
registration: `app.use(logger as RequestHandler)` is middleware as
`app.use(logger)` is, and `app.route("/users")!.get(h)` is a route as
`app.route("/users").get(h)` is.

Confidence is `high` when the file imports the `express` package or one of its
subpaths (or reaches Express via CommonJS `require('express')`) and `medium`
otherwise — the classification survives so the workspace projection still
surfaces the shape, but consumers can treat medium-confidence rows as
candidates for review. The import is read from the file's parsed import list,
so the line breaks it is written with do not matter and a commented-out import
does not count. When that list names no `express`, the source is read as
tokens, with comments skipped and literals read whole, for a `require` call
and for an import the list missed (one the parser lost to a syntax error, or
one inside a `declare module` block). JSX text with a quote or backtick in it
can mislead that reading on the lines it spans.

Not classified today (documented for completeness):

- Route handlers defined as separate declarations
  (`function getUsers(req, res) {…}`) — Aburi's Symbol extractor cannot see the
  call-site linkage without cross-symbol lookup, so these remain plain
  `function` Symbols. The `app.get('/users', getUsers)` call itself IS
  classified via the promoted `kind: "call"` Symbol.
- Type-level inferences (whether a `Handler` typed function argument is an
  Express handler). The arity heuristic used here is the most reliable
  pre-LSP signal for a middleware / error-middleware split.
- A name a destructuring pattern pulls out of a `Router()` call
  (`const { stack } = Router()`) — the binding is not the Router, only
  something read off it.
- A route whose only handler is awaited (`app.get(p, await makeHandler())`) or
  constructed (`app.get(p, new AsyncHandler(h))`) — either is ordinarily data
  when handed to a `put` or a `post` (`axios.post(url, new FormData(form))`).
- An argument behind an old-style type assertion (`app.get(p, <RequestHandler>h)`,
  `app.use(<RequestHandler>logger)`) — `@aburi/lang-typescript` does not read
  through `<T>x` either, and the two readers have to agree.
- A route registered on a name an `app.route(path)` call was bound to
  (`const r = app.route("/users")`, then `r.get(h)`) — `r.get(h)` is shaped
  like `cache.get(key)`, and the plugin reads one statement at a time, so it
  cannot see where `r` came from.
- An `app.route(...)` chain whose path is not a literal beginning with `/`
  (`app.route(USERS_PATH).get(h)`) — `route` is shared vocabulary too, and a
  builder's `db.route("users").delete(id)` has the same shape.

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

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:express:*`) plug into the shared vocab.
- [`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md) — plugin authoring walkthrough with cross-references to this package's tests.
