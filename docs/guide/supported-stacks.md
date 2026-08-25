# Supported stacks

Aburi ships as a small CLI plus plugins. Install the ones that match your
project. `aburi init --with-suggestions` will name them for you.

## Languages

You need one language plugin per language in the repository.

| Package | Covers |
|---|---|
| `@aburi/lang-typescript` | `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx` |

Parsing runs on tree-sitter WASM, so you get no native build step and no
compiler in the loop.

Python, Go, and a functional language are planned. See the [roadmap](/roadmap).

## Frameworks

A framework plugin is what turns a class into "an HTTP endpoint" in the report.
Install as many as apply. They do not conflict.

| Package | Recognises |
|---|---|
| `@aburi/framework-nestjs` | `@Module`, `@Controller`, `@Injectable`, HTTP and WebSocket method decorators, guards, interceptors, pipes, filters |
| `@aburi/framework-next` | App Router files (`page`, `layout`, `route`, `template`, `loading`, `error`, `not-found`) and the `"use client"` / `"use server"` directives |
| `@aburi/framework-express` | Router instances, route handlers, middleware, error handlers, mount points |
| `@aburi/framework-react` | Function components, custom hooks, contexts and providers, `forwardRef`, `memo`, higher-order components |

Nothing here fits? For a decorator-based framework,
[`frameworkHints`](/guide/configuration#teach-it-your-in-house-framework) covers
you from config. For anything else, write a
[plugin](/extend/plugin-development).

## Effects

An effects plugin is what lets the report say "this method now writes to the
database". Without one, Aburi still records the call, but attaches no meaning
to it.

| Package | Detects | Reported as |
|---|---|---|
| `@aburi/effects-prisma` | `prisma.<model>.<verb>`, `$transaction` | `db.read`, `db.write`, `db.transaction` |
| `@aburi/effects-drizzle` | `db.select` / `insert` / `update` / `delete`, `query.<table>.findMany`, `transaction` | `db.read`, `db.write`, `db.transaction` |
| `@aburi/effects-trpc` | tRPC client calls and the React Query hook surface | `network.rpc` |
| `@aburi/effects-nest` | `EventEmitter2` / `eventBus` `.emit(...)` | `event.publish` |

Aburi detects an effect at the call site. A method that calls a repository
method that writes to the database does not yet inherit `db.write`. Propagation
along the call graph is on the [roadmap](/roadmap).

## Example setups

::: code-group

```bash [Next.js + Drizzle]
pnpm add -D @aburi/cli @aburi/lang-typescript \
  @aburi/framework-next @aburi/framework-react @aburi/effects-drizzle
```

```bash [NestJS + Prisma]
pnpm add -D @aburi/cli @aburi/lang-typescript \
  @aburi/framework-nestjs @aburi/effects-prisma @aburi/effects-nest
```

```bash [Express]
pnpm add -D @aburi/cli @aburi/lang-typescript @aburi/framework-express
```

:::
