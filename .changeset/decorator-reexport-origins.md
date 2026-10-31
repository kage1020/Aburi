---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
"@aburi/framework-nestjs": minor
---

A NestJS decorator re-exported through a workspace barrel is now graded by the module that declares it, so `import { Controller } from "@app/common"`, where `@app/common` is a `tsconfig.json` path alias to a barrel that re-exports `@nestjs/common`, classifies at `high` confidence rather than `medium`. The same holds for a relative barrel (`../common`), for a chain of barrels, for a decorator renamed on import and for one read through a namespace import. A barrel that re-exports a competing library, declares the decorator itself, or reaches it only through `export *` still grades `medium`, as does an alias that maps to no file in the workspace.

Before framework classification the scan follows each name a decorator binds through the barrels it reaches, and records on the new `ImportEdge.origins` the module outside the workspace the name comes from. A bare specifier reaches a barrel through the new optional `LanguagePlugin.createImportResolver`, which the TypeScript plugin implements by reading the nearest `tsconfig.json` (or `jsconfig.json`): `compilerOptions.paths` and `baseUrl`, through `extends` chains, relative or from a package, and `${configDir}`. Only decorators are followed, and only when a framework plugin is loaded, so a barrel is parsed at most once more per scan and a scan without framework plugins does no extra work. A framework plugin that grades provenance reads `edge.origins?.get(importedName) ?? edge.source`.

A controller, provider or route that reached its decorator through such a barrel moves from `medium` to `high`, so an IR scanned before this release, compared with one scanned after, reports a `confidence: medium → high` change on each. Rescan the base rather than comparing against a stored IR; `aburi diff <base>..<head>` scans both sides with the installed plugins and is unaffected.
