---
"@aburi/framework-react": minor
"@aburi/lang-typescript": minor
"@aburi/cli": patch
---

Add `@aburi/framework-react`, a new framework plugin that classifies React
sources into seven `framework:react:*` extKinds so React codebases (Vite / CRA
/ library authors — not just Next.js App Router) can be scanned by Aburi.

Recognised shapes (first-match-wins in the order listed):

- `framework:react:hook` — `/^use[A-Z]/` naming, with an extra `hook-call`
  `derivedBy` signal when the body calls another `use*` function
- `framework:react:context` — `const X = createContext(...)` / `React.createContext(...)`
- `framework:react:forward-ref` — `const X = forwardRef(...)` / `React.forwardRef(...)`
- `framework:react:memo` — `const X = memo(...)` / `React.memo(...)`
- `framework:react:provider` — PascalCase function whose returned JSX has
  `<X.Provider>` at its root
- `framework:react:hoc` — `/^with[A-Z]/` naming
- `framework:react:component` — PascalCase function whose body returns JSX
  (fallback)

Detection is decorator-free: signals come from the symbol's name (leaf-of-qname
regex), its `bodyNode` (tree-sitter walker looking for `jsx_element` /
`jsx_self_closing_element` / `jsx_fragment`), and its `fullNode` (pre-order
walk finding the outermost `call_expression` for the const-wrapper family). The
plugin duck-types the tree-sitter node surface rather than depending on
`web-tree-sitter` directly.

`@aburi/lang-typescript`: extends `fileExtensions` and the internal
`EXTENSION_GRAMMAR` map to accept `.js` / `.mjs` / `.cjs` (TypeScript grammar,
permissively) and `.jsx` (tsx grammar, JSX-aware). This is what lets
`@aburi/framework-react` classify React sources in plain-JavaScript codebases.

`@aburi/cli`: `aburi init --with-suggestions` now maps a detected `react`
framework to `@aburi/framework-react` alongside the existing `nestjs` /
`nextjs` entries.

Closes #32.
