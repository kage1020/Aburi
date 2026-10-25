---
"@aburi/config": patch
"@aburi/lang-typescript": patch
"@aburi/framework-next": patch
---

The READMEs describe what the packages do. `@aburi/config` returns `found: false` when no config exists rather than falling back to an autodetected one, and `aburi scan` refuses that empty config. `@aburi/lang-typescript` is loaded by its plugin name, `lang-typescript`, not by `typescript` or `ts`. `@aburi/framework-next` tags a `"use server"` App Router file as `framework:next:server-action` as well as a `"use client"` one as `framework:next:client-component`, and only on the Symbols it already classifies.
