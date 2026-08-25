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

Component roles accept both React (`.tsx` / `.jsx`) and non-React (`.ts` / `.js`)
extensions. `route.*` intentionally does **not** accept `.tsx` / `.jsx`: route
files export named HTTP verb handlers and do not participate in JSX rendering,
so restricting extensions matches the Next.js runtime and prevents `route.tsx`
siblings from being misclassified.

Not classified today (documented for completeness): `default`, `global-error`,
`middleware`, `instrumentation`, and the metadata files (`sitemap`, `icon`,
`opengraph-image`, …). Adding them is a table extension inside `app-router.ts`.

Client / server component discrimination folds into `derivedBy` (`framework:next:client-component`
when a `"use client"` directive is present).

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

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) §5.2 — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:next:*`) plug into the shared vocab.
