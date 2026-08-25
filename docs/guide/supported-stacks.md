# Supported stacks

Aburi ships as a small CLI plus plugins. Install the ones that match your
project — `aburi init --with-suggestions` will name them for you.

## Languages

You need exactly one language plugin per language in the repository.

| Package | Covers |
|---|---|
| `@aburi/lang-typescript` | `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx` |

Parsing runs on tree-sitter WASM, so there is no native build step and no
compiler in the loop.

Python, Go, and a functional language are planned — see the
[roadmap](/roadmap).

## Frameworks

Framework plugins are what turn a class into "an HTTP endpoint" in the report.
Install as many as apply; they do not conflict.

| Package | Recognises |
|---|---|
| `@aburi/framework-nestjs` | `@Module`, `@Controller`, `@Injectable`, HTTP and WebSocket method decorators, guards, interceptors, pipes, filters |
| `@aburi/framework-next` | App Router files (`page`, `layout`, `route`, `template`, `loading`, `error`, `not-found`) and the `"use client"` / `"use server"` directives |
| `@aburi/framework-express` | Router instances, route handlers, middleware, error handlers, mount points |
| `@aburi/framework-react` | Function components, custom hooks, contexts and providers, `forwardRef`, `memo`, higher-order components |

Nothing here? [`frameworkHints`](/guide/configuration#teach-it-your-in-house-framework)
covers decorator-based frameworks with a few lines of config, and a
[plugin](/extend/plugin-development) covers the rest.

## Effects

Effects plugins are what let the report say "this method now writes to the
database". Without one, calls are still recorded — they just have no meaning
attached.

| Package | Detects | Reported as |
|---|---|---|
| `@aburi/effects-prisma` | `prisma.<model>.<verb>`, `$transaction` | `db.read`, `db.write`, `db.transaction` |
| `@aburi/effects-drizzle` | `db.select` / `insert` / `update` / `delete`, `query.<table>.findMany`, `transaction` | `db.read`, `db.write`, `db.transaction` |
| `@aburi/effects-trpc` | tRPC client calls and the React Query hook surface | `network.rpc` |
| `@aburi/effects-nest` | `EventEmitter2` / `eventBus` `.emit(...)` | `event.publish` |

Effects are detected **at the call site**. A method that calls a repository
method that writes to the database does not yet inherit `db.write` —
propagation along the call graph is on the [roadmap](/roadmap).

## Example setups

::: code-group

```bash [NestJS + Prisma]
pnpm add -D @aburi/cli @aburi/lang-typescript \
  @aburi/framework-nestjs @aburi/effects-prisma @aburi/effects-nest
```

```bash [Next.js + Drizzle]
pnpm add -D @aburi/cli @aburi/lang-typescript \
  @aburi/framework-next @aburi/framework-react @aburi/effects-drizzle
```

```bash [Express]
pnpm add -D @aburi/cli @aburi/lang-typescript @aburi/framework-express
```

:::
