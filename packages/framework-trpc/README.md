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
function, or a name for one — on a chain built from a procedure: one that reads
`.procedure` on the way (`t.procedure.query(…)`) or starts from a name ending
in `Procedure` (`publicProcedure`, `protectedProcedure`), which is how tRPC's
documentation and create-t3-app name their base procedures. The chain is what
tells `publicProcedure.query(resolve)` from `db.query(fn)` and from the client
call `client.user.byId.query({ id })`. A base procedure is the same chain ending
in `use`, `input`, `output`, `meta` or `concat` instead, or the bare
`t.procedure`. The three procedure kinds share one extKind, as an Express
route's methods do, and `derivedBy` names which one it is.

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
subpaths, type-only imports included, and `medium` otherwise. The names this
plugin reads are tRPC's conventions rather than its exports, and the usual
layout keeps the import in one file: create-t3-app's routers import
`createTRPCRouter` and `publicProcedure` from `~/server/api/trpc`, so their
routers and procedures are `medium`.

A procedure's resolver is its Symbol's body, so the calls, rules and effects
written in it are the procedure's: with
[`@aburi/effects-prisma`](../effects-prisma/README.md), a mutation whose
resolver calls `prisma.user.create(…)` carries `db.write`.

Not classified today:

- A procedure written inside a router's object literal
  (`router({ byId: publicProcedure.query(…) })`). `@aburi/lang-typescript`
  gives an object handed to a call no member Symbols, so there is no Symbol to
  classify, and the resolver is in no Symbol either. The router itself is
  classified. Declare the procedure as a `const` and name it in the router to
  give it a Symbol.
- A base procedure behind a name that does not end in `Procedure`
  (`const base = t.procedure`, then `base.query(fn)`). The plugin reads one
  declaration at a time, so it cannot see where `base` came from.
- A router or middleware factory under a name other than tRPC's
  (`const makeRouter = t.router`, then `makeRouter({ … })`), for the same reason.
- `experimental_standaloneMiddleware`, `createCallerFactory(appRouter)` and
  `appRouter.createCaller(ctx)`.
- A file that reaches `@trpc/server` only through CommonJS
  (`const { initTRPC } = require("@trpc/server")`): the import list carries no
  edge for a `require` call, so its shapes are `medium`.

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
