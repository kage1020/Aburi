# @aburi/framework-react

React framework plugin for `@aburi/core`. Classifies React function components,
custom hooks, contexts, `forwardRef` / `memo` wrappers, context providers, and
higher-order components into `framework:react:*` extKinds so downstream tooling
can group them in the workspace projection.

Recognised shapes:

| Source shape | `extKind` | Signal |
|---|---|---|
| `function Widget() { return <div/> }` | `framework:react:component` | PascalCase name + JSX return |
| `const Widget = () => <div/>` | `framework:react:component` | PascalCase name + JSX return |
| `function useThing() { … }` | `framework:react:hook` | `/^use[A-Z]/` name |
| `function useX() { useState(…); … }` | `framework:react:hook` (+ `hook-call` signal) | naming + inner hook call |
| `const Ctx = createContext(…)` | `framework:react:context` | that const's own initializer is a `createContext(...)` / `React.createContext(...)` call |
| `const B = forwardRef((p,r) => …)` | `framework:react:forward-ref` | that const's own initializer is a `forwardRef(...)` / `React.forwardRef(...)` call |
| `const M = memo(Inner)` | `framework:react:memo` | that const's own initializer is a `memo(...)` / `React.memo(...)` call |
| `function P() { return <Ctx.Provider>…</Ctx.Provider> }` | `framework:react:provider` | PascalCase + `<X.Provider>` root JSX |
| `function withAuth(C) { … }` | `framework:react:hoc` | `/^with[A-Z]/` name |

Priorities are first-match-wins in the order listed above: a `useX` function
that also returns JSX still classifies as `hook`, and a `<Ctx.Provider>`-shaped
component classifies as `provider` rather than `component`.

A const is read from its own declarator, so in
`export const PAGE_SIZE = 20, Row = memo(RowImpl)` only `Row` is a memo. The
initializer must be the wrapper call itself, read through `as`, `satisfies`,
`!` and parentheses as `@aburi/lang-typescript` reads it to name the Symbol
(`memo(Row) as typeof Row` is a memo), and its outermost call names the role,
so `memo(forwardRef(…))` is a memo. A const whose initializer only contains a
wrapper call (in an array or object literal, handed to another call or to
`new`, in one branch of a conditional), or that a destructuring pattern pulls
out of one, has no wrapper role: it holds that expression's value, not
necessarily the wrapped component.

That call is named in `derivedBy` by the name read off the syntax tree: the
name the callee's receiver chain starts from, read through the same wrappers,
and the name called. `React.memo(Inner)`, `(React as any).memo(Inner)` and the
same call wrapped over two lines or with a comment before `.memo` all give
`framework:react:memo:React.memo`, and `memo(Inner)` gives
`framework:react:memo:memo`. A receiver that is not a name is `<computed>`
(`new Registry().memo(Inner)` gives `framework:react:memo:<computed>.memo`), so
no entry carries the source's line breaks, indentation or comments.

Not classified today (documented for completeness):

- Class components (`class X extends React.Component`) — the plugin only
  targets function components; adding class support is a separate signal path.
- `"use client"` / `"use server"` directives — those are the `framework-next`
  plugin's responsibility.
- Signals that require type-level information (whether a function's return
  type resolves to `ReactNode`, whether an HOC parameter is typed as a
  component). The JSX-body heuristic used here is the most reliable pre-LSP
  signal.
- A wrapper behind an old-style type assertion (`<Context<T>>createContext(…)`,
  `<any>memo(Inner)`, written in a `.ts` file) — the initializer is read
  through `as`, `satisfies`, `!` and parentheses only, as
  `@aburi/lang-typescript` reads it to name the Symbol.

## Install

```bash
pnpm add @aburi/framework-react
```

## Usage

```ts
import { reactFrameworkPlugin } from "@aburi/framework-react"
```

The plugin's `provides.frameworks: ["react"]` matches `@aburi/core`'s Component
autodetect against a workspace `react` npm dependency. Adding
`"@aburi/framework-react"` to `aburi.json`'s `frameworks` array wires it into
the scan pipeline; the `aburi init --with-suggestions` output includes it
automatically when a React dependency is detected.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:react:*`) plug into the shared vocab.
- [`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md) — plugin authoring walkthrough with cross-references to this package's tests.
