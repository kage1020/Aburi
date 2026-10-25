# @aburi/framework-next

Next.js framework plugin for `@aburi/core`. Recognises the App Router special
files by path convention and classifies them into `framework:next:*` extKinds
so downstream tooling can group them (e.g. surface every `page` as a boundary
in the workspace projection).

Recognised files under `app/**/`:

| File | `extKind` |
|---|---|
| `page.{ts,tsx,js,jsx}` | `framework:next:page` |
| `layout.{ts,tsx,js,jsx}` | `framework:next:layout` |
| `template.{ts,tsx,js,jsx}` | `framework:next:template` |
| `loading.{ts,tsx,js,jsx}` | `framework:next:loading` |
| `error.{ts,tsx,js,jsx}` | `framework:next:error` |
| `not-found.{ts,tsx,js,jsx}` | `framework:next:not-found` |
| `route.{ts,js}` | `framework:next:route` |

A component role (`page` through `not-found`) is the file's default export, written
`export default function Page()`, `export default Page` or `export { Page as default }`.

A route is what `route.{ts,js}` exports under an HTTP verb name (`GET`, `POST`, `PUT`,
`DELETE`, `PATCH`, `OPTIONS`, `HEAD`). Next.js dispatches to the module's exports by name, so
the plugin reads the export, not the declaration's name:

| Written | Routes |
|---|---|
| `export async function GET() {}` | `GET` |
| `export const GET = async () => …` | `GET` |
| `export const { GET, POST } = handlers` (Auth.js) | `GET`, `POST` |
| `export const GET = auth(async (req) => …)` | `GET` |
| `async function POST() {}` with `export { POST }` | `POST` |
| `const handler = NextAuth(options)` with `export { handler as GET, handler as POST }` | `GET` and `POST`, both on the one Symbol `handler` |
| `function OPTIONS() {}`, not exported | none |
| `function GET() {}` with `export type { GET }` | none: a type-only export is erased at runtime |
| `export { GET, POST } from "@/auth"` (Auth.js v5 beta) | none: a re-export declares nothing in the route file, so there is no Symbol to classify |
| `function GET() {}` with CommonJS `module.exports = { GET }` | none: only ESM exports are read |

A declaration exported only as `default`, or from inside a namespace, is not a route either.
The handler is a `function` Symbol where the language plugin can see its value is a function,
and a `const` where it cannot (a destructuring, a call's result). Both get the one extKind
`framework:next:route`, so a consumer filtering on it sees every route; its manifest
`baseKind` is `function`, what Next.js calls, and the Symbol's `kind` stays the language
plugin's reading. Export clauses are read by `@aburi/lang-typescript`, which records the name
each clause exports a declaration under.

The names a declaration is exported under are an input of its `api` fingerprint, so a
clause-exported handler gaining or losing a verb (`export { handler as GET }` becoming
`export { handler as GET, handler as DELETE }`) is an API change in `aburi diff`, reported with
the export names it gained and lost. A handler exported by its keyword is named by its verb, so
changing the verb reports it as removed and added.

Component roles accept both React (`.tsx` / `.jsx`) and non-React (`.ts` / `.js`)
extensions. `route.*` intentionally does **not** accept `.tsx` / `.jsx`: route
files export named HTTP verb handlers and do not participate in JSX rendering,
so restricting extensions matches the Next.js runtime and prevents `route.tsx`
siblings from being misclassified.

Not classified today (documented for completeness): `default`, `global-error`,
`middleware`, `instrumentation`, and the metadata files (`sitemap`, `icon`,
`opengraph-image`, …). Adding them is a table extension inside `app-router.ts`.

Client / server discrimination folds into `derivedBy`: a `"use client"` or `"use server"` directive
at the top of an App Router file adds `framework:next:client-component` or
`framework:next:server-action` to the Symbols classified above. A server action in a file no
App Router convention names (`app/orders/actions.ts`) is not classified.

## Install

```bash
pnpm add @aburi/framework-next
```

## Usage

```ts
import { nextFrameworkPlugin } from "@aburi/framework-next"
```

`aburi init` writes `"framework-next"` into `aburi.json` under `frameworks`,
which is the plugin manifest name the loader resolves (to `@aburi/framework-next`
via the bare-name prefix — see
[`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md)). The short
framework id `"nextjs"` that component autodetect uses stays inside
`components[].frameworks`; the two fields carry different vocabularies and no
hand-editing is needed.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:next:*`) plug into the shared vocab.
