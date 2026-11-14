# @aburi/framework-trpc

tRPC framework plugin for `@aburi/core`. Classifies the **server** side of
tRPC — the instance, routers, procedures, base procedures and middleware —
into `framework:trpc:*` extKinds, so they are Boundaries in the IR. The client
side, the calls that reach a procedure over the network, is
[`@aburi/effects-trpc`](../effects-trpc/README.md)'s.

Every shape is a `const` whose own declarator holds it:

| Source shape | `extKind` | `derivedBy` |
|---|---|---|
| `const t = initTRPC.create()`, `initTRPC.context<Context>().meta<Meta>().create({ … })` | `framework:trpc:instance` | `framework:trpc:instance:initTRPC.create` |
| `const appRouter = t.router({ … })`, `router({ … })`, `createTRPCRouter({ … })` | `framework:trpc:router` | `framework:trpc:router:t.router` |
| `const merged = t.mergeRouters(a, b)`, `mergeRouters(a, b)` | `framework:trpc:router` | `framework:trpc:router:t.mergeRouters` |
| `const byId = publicProcedure.input(schema).query(({ input }) => …)` | `framework:trpc:procedure` | `framework:trpc:procedure:publicProcedure.query` |
| `const create = protectedProcedure.mutation(…)`, `t.procedure.subscription(…)` | `framework:trpc:procedure` | `framework:trpc:procedure:protectedProcedure.mutation` |
| `const publicProcedure = t.procedure` | `framework:trpc:base-procedure` | `framework:trpc:base-procedure:t.procedure` |
| `const protectedProcedure = t.procedure.use(isAuthed)`, `protectedProcedure.use(isAdmin)` | `framework:trpc:base-procedure` | `framework:trpc:base-procedure:t.use` |
| `const isAuthed = t.middleware(({ ctx, next }) => …)`, `middleware(fn)` | `framework:trpc:middleware` | `framework:trpc:middleware:t.middleware` |

A procedure is a `query`, `mutation` or `subscription` handed its resolver — a
function, an async generator (tRPC v11's subscriptions), a name for one, or a
call that returns one (`withCache(listUsers)`) — on a chain built from a
procedure: one that reads `.procedure` straight off a plain name
(`t.procedure.query(…)`) or starts from a name that is `procedure` or ends in
`Procedure` (`publicProcedure`, `protectedProcedure`), which is how tRPC's
documentation and create-t3-app name their base procedures. The chain is what
tells `publicProcedure.query(resolve)` from `db.query(fn)` and from the client
call `client.user.byId.query({ id })`. A base procedure is the same chain ending
in `use`, `input`, `output`, `meta` or `concat` instead, or the bare
`t.procedure`. That bare read is taken only off a plain name and only in a file
that imports `@trpc/server`, the file that creates the instance: `procedure` is
a domain word as well, and `form.procedure` reads the same. The three procedure
kinds share one extKind, as an Express route's methods do, and `derivedBy` names
which one it is.

A router is `router` or `createTRPCRouter` handed one object literal, or
`mergeRouters` handed the routers it merges; another library's
`createRouter({ routes })` is not one. An alias of a factory
(`export const createTRPCRouter = t.router`) is not classified: it builds
nothing until it is called.

`derivedBy` names the call `<receiver>.<method>`, read off the syntax tree as
every framework plugin reads it: the method called and the name the receiver
chain starts from, through `as`, `satisfies`, `!`, parentheses and every call
on the way. So a chain wrapped over several lines, or with a comment in it,
gives the same entry, and `t.procedure.use(timing).query(fn)` is
`t.query`. The bare `t.procedure` is named the same way, `t.procedure`.

Confidence is `high` when the file imports `@trpc/server` or one of its
subpaths, type-only imports included, and `medium` otherwise. Most of the
names this plugin reads are tRPC's conventions rather than its exports
(`initTRPC` is the exception), and the usual layout keeps the import in one
file: create-t3-app's routers import
`createTRPCRouter` and `publicProcedure` from `~/server/api/trpc`, so their
routers and procedures are `medium`.

A procedure's resolver is its Symbol's body, so the calls, rules and effects
written in it are the procedure's: with
[`@aburi/effects-prisma`](../effects-prisma/README.md), a mutation whose
resolver calls `prisma.user.create(…)` carries `db.write`.

A procedure or base procedure also names its middleware, which `@aburi/core`
writes to the Symbol's `middleware` and the logic fingerprint reads, so a
procedure that loses `.use(isAuthed)` is a logic change the report names
(`- middleware removed: isAuthed`) rather than a reformat, and two `.use` calls
swapped are one with `reordered: true`. The names are what each `.use(…)` on
the declaration's own chain is handed and the builder each `.concat(…)` joins,
whose middleware runs where the call is written, in the order they run:
`t.procedure.use(timing).use(isAuthed).query(fn)` names `timing` and
`isAuthed`. An inline middleware is left out, since its body is the Symbol's
own and already read. Each entry is named from the syntax tree as
[`@aburi/framework-express`](../framework-express/README.md) names its
middleware, so line breaks, comments and quote style do not reach it:
`isAuthed`, `auth.required`, `requireRole("admin")` for `requireRole('admin')`,
`rateLimit(…)` for `rateLimit({ max: 10 })`, and `<computed>` for anything no
name spells.

The middleware a base procedure adds is named on the base procedure, not on
what is built from it. `protectedProcedure.query(fn)` names none, and removing
`.use(isAuthed)` from `protectedProcedure = t.procedure.use(isAuthed)` is a
logic change to `protectedProcedure` alone: the plugin reads one declaration at
a time, so it cannot follow `protectedProcedure` to the chain that built it.

Not classified today:

- A procedure written inside a router's object literal
  (`router({ byId: publicProcedure.query(…) })`). `@aburi/lang-typescript`
  gives an object handed to a call no member Symbols, so there is no Symbol to
  classify, and the resolver is in no Symbol either. The router itself is
  classified. Declare the procedure as a `const` and name it in the router to
  give it a Symbol.
- What is built on a base procedure whose name is neither `procedure` nor ends
  in `Procedure` (`const base = t.procedure`, then `base.query(fn)` or
  `base.use(x)`). `base` itself is classified, but the plugin reads one
  declaration at a time, so it cannot see where `base` came from.
- The bare `t.procedure` in a file that does not import `@trpc/server`.
- A router or middleware factory under a name other than tRPC's
  (`const makeRouter = t.router`, then `makeRouter({ … })`), for the same reason.
- `experimental_standaloneMiddleware`, `createCallerFactory(appRouter)` and
  `appRouter.createCaller(ctx)`.
- A file that reaches `@trpc/server` only through CommonJS
  (`const { initTRPC } = require("@trpc/server")`): the import list carries no
  edge for a `require` call, so its shapes are `medium`.

Classified though not tRPC's: the receiver's name is all a declaration shows,
so another library's shapes under tRPC's names are read as tRPC's, at `medium`
in a file that does not import `@trpc/server`. A ts-rest contract
(`c.router({ getPost: … })`) and an oRPC router (`os.router({ ping })`) are
routers, `app.middleware(handler)` is a middleware, and a `query` on a name
ending in `Procedure` (`storedProcedure.query(sql)`) is a procedure.

## Install

```bash
pnpm add @aburi/framework-trpc
```

## Usage

```ts
import { trpcFrameworkPlugin } from "@aburi/framework-trpc"
```

The plugin's `provides.frameworks: ["trpc"]` matches `@aburi/core`'s Component
autodetect against a workspace `@trpc/server` npm dependency, and `aburi init`
writes `"framework-trpc"` into `aburi.json`'s `frameworks` array for one.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:trpc:*`) plug into the shared vocab.
- [`@aburi/effects-trpc`](../effects-trpc/README.md) — the client side of tRPC.
