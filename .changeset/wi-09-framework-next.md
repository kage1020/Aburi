---
"@aburi/framework-next": minor
---

Introduce `@aburi/framework-next`, the Next.js framework plugin. Recognizes the App Router special files (page / layout / template / loading / error / not-found / route) and the top-of-module `"use client"` / `"use server"` directives.

### File-based classification

The plugin joins two signals from the extraction pipeline:
- `Symbol.source.file` → resolved against the App Router path convention. A file only counts as an App Router special file when the path includes an `app/` segment and the base filename is one of the seven reserved names with a `.ts` / `.tsx` / `.js` / `.jsx` extension.
- `ctx.file.content` → scanned for a top-of-module `"use client"` / `"use server"` directive.

### Component roles

- `app/**/page.{ts,tsx}` default export function → `framework:next:page`
- `app/**/layout.{ts,tsx}` default export function → `framework:next:layout`
- `app/**/template.{ts,tsx}` → `framework:next:template`
- `app/**/loading.{ts,tsx}` → `framework:next:loading`
- `app/**/error.{ts,tsx}` → `framework:next:error`
- `app/**/not-found.{ts,tsx}` → `framework:next:not-found`

Named-but-default exports (`export default function Page() {}`) are recognized via the language plugin's `export-default` derivedBy marker rather than via the qname, so the plugin catches both the anonymous and named forms.

### Route handlers

`app/**/route.{ts,js}` named HTTP verb exports (GET / POST / PUT / DELETE / PATCH / OPTIONS / HEAD) → `framework:next:route`. Non-verb helper exports in the same file are ignored.

### Client / server distinction

When the file starts with `"use client"` or `"use server"`, the classifier appends `framework:next:client-component` / `framework:next:server-action` to the `derivedBy` string after a `;` delimiter. Consumers that split on `;` recover both signals; the framework role stays in the leading segment for consumers that only need it.

### Manifest

`extKindPrefixes: ["framework:next"]` for future App Router additions plus individual `extKinds` enumeration (7 ids, all `baseKind: function`) so `VocabRegistry.findExtKind()` returns proper baseKind fallback. `frameworks: ["nextjs"]` matches the identifier `@aburi/core`'s Component autodetect emits for the `next` dependency.

### Public API

`nextFrameworkPlugin` (ready-to-register instance), `NextFrameworkPlugin` (class), `frameworkNextManifest`, `classifyNextSymbol`, `recognizeAppRouterFile`, `detectModuleDirective`, `NEXT_APP_ROUTER_ROLES`, `NEXT_ROUTE_HTTP_VERBS`, plus types `AppRouterFile`, `AppRouterRole`, `ModuleDirective`.
