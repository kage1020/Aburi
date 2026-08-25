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
| `const Ctx = createContext(…)` | `framework:react:context` | `createContext(...)` / `React.createContext(...)` |
| `const B = forwardRef((p,r) => …)` | `framework:react:forward-ref` | `forwardRef(...)` / `React.forwardRef(...)` |
| `const M = memo(Inner)` | `framework:react:memo` | `memo(...)` / `React.memo(...)` |
| `function P() { return <Ctx.Provider>…</Ctx.Provider> }` | `framework:react:provider` | PascalCase + `<X.Provider>` root JSX |
| `function withAuth(C) { … }` | `framework:react:hoc` | `/^with[A-Z]/` name |

Priorities are first-match-wins in the order listed above: a `useX` function
that also returns JSX still classifies as `hook`, and a `<Ctx.Provider>`-shaped
component classifies as `provider` rather than `component`.

Not classified today (documented for completeness):

- Class components (`class X extends React.Component`) — the plugin only
  targets function components; adding class support is a separate signal path.
- `"use client"` / `"use server"` directives — those are the `framework-next`
  plugin's responsibility.
- Signals that require type-level information (whether a function's return
  type resolves to `ReactNode`, whether an HOC parameter is typed as a
  component). The JSX-body heuristic used here is the most reliable pre-LSP
  signal.

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

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) §5.2 — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:react:*`) plug into the shared vocab.
- [`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md) — plugin authoring walkthrough with cross-references to this package's tests.
