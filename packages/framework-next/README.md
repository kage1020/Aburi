# @aburi/framework-next

Next.js framework plugin for `@aburi/core`. Recognises the App Router special
files by path convention and classifies them into `framework:next:*` extKinds
so downstream tooling can group them (e.g. surface every `page` as a boundary
in the workspace projection).

Recognised files under `app/**/`:

| File | `extKind` |
|---|---|
| `page.tsx` / `page.ts` / `page.js` | `framework:next:page` |
| `layout.tsx` | `framework:next:layout` |
| `route.ts` | `framework:next:route` |
| `template.tsx` | `framework:next:template` |
| `loading.tsx` | `framework:next:loading` |
| `error.tsx` / `global-error.tsx` | `framework:next:error` |
| `not-found.tsx` | `framework:next:not-found` |
| `default.tsx` | `framework:next:default` |

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

`aburi init` writes `framework-next` into `aburi.json` under `frameworks` when
it autodetects Next.js in your dependencies.

## See also

- [`design/details/framework-plugin.md`](../../design/details/framework-plugin.md)
