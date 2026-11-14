---
"@aburi/core": minor
---

Resolve a call through a `tsconfig.json` path alias. `formatInvoice()` through `import { formatInvoice } from "@app/billing"`, where `paths` maps `@app/billing` to a workspace file, now reaches `libs/billing/src/index.ts#formatInvoice` at `high` confidence instead of being bucketed `external`. While it extracts a file whose Symbols make calls, the scan asks the language plugin's import resolver what each bare specifier the file imports names through maps to, and call resolution probes those paths against the files the scan has Symbols in, as it probes a relative specifier's. A name the mapped file does not declare is bucketed `no-match`, and a specifier that maps to no such file, a package's or a workspace package's name, stays `external` as before. `resolveCallGraph` takes the mapped paths as `specifierPaths`.

On the pinned benchmark repositories, checked out without their dependencies installed: `shadcn-ui` resolves 3,140 more calls (6,390 → 9,530; `external` 21,593 → 18,085), `cal-com` 1,930 more (9,872 → 11,802; `external` 38,876 → 36,833), `trpc` 399 (1,696 → 2,095), `zustand` 173 (169 → 342), `nest` 58, `tanstack-query` 12 and `zod` 11; `express` and `hono` are unchanged. `no-match` grows by the names a mapped barrel re-exports rather than declares (`shadcn-ui` +368, `cal-com` +113, `trpc` +47, `zod` +10).

Since every scan now reads the `tsconfig.json` its files are compiled under, a config the resolver cannot use, or an `extends` entry that names no installed config, is warned about in any scan, not only one with a framework plugin loaded.
