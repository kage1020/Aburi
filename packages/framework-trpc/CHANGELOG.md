# @aburi/framework-trpc

## 0.2.0

### Minor Changes

- 3b3d306: Move the documentation site and the JSON Schemas to `aburi.dev`
  
  The four schemas now identify themselves as `https://aburi.dev/schema/...`, and that is the `$schema` an IR, a diff, an `aburi init` config and every bundled plugin manifest carries. The site, including the schemas under `/schema/`, is served from `https://aburi.dev`.
  
  Nothing written before has to change. Each schema's `$schema` now accepts the `aburi.kage1020.com` URL it carried until now beside the `aburi.dev` one, so an existing `aburi.json`, a plugin manifest naming the former host, and a committed IR all stay valid v1: `aburi diff` and `aburi explain` read such an IR, and a base and head that differ only in which host they name are diffed as one schema version. The former host keeps answering, so an editor resolving an old `$schema` line still finds the schema.
  
  `@aburi/types` exports the URLs Aburi writes — `IR_SCHEMA_URL`, `DIFF_SCHEMA_URL`, `CONFIG_SCHEMA_URL`, `PLUGIN_SCHEMA_URL` — and `isIRSchemaURL`, which accepts every `$schema` the IR schema does. The generated `$schema` types widen to the two values each schema accepts.
  
  An earlier `@aburi/cli` accepts only the former host, so it refuses everything this release writes: the `aburi.json` that `aburi init` writes (or one whose `$schema` line follows the docs) fails with `config-invalid` at exit 2, an IR from `aburi scan` is refused by `aburi diff <files>` and `aburi explain`, and a plugin from this release fails to load. Upgrade the CLI first — including a GitHub Action `version:` pinned to an earlier one — and then the configs and plugins.

### Patch Changes

- Updated dependencies: `@aburi/core@0.7.0`, `@aburi/types@0.7.0`

## 0.1.0

### Minor Changes

- bb90fea: New package `@aburi/framework-trpc` classifies the server side of tRPC as Boundaries: the `initTRPC` instance (`framework:trpc:instance`), routers and merged routers (`framework:trpc:router`), `query` / `mutation` / `subscription` procedures (`framework:trpc:procedure`), base procedures such as `t.procedure.use(isAuthed)` (`framework:trpc:base-procedure`) and middleware (`framework:trpc:middleware`), each a `const` whose own declarator holds the shape. A procedure's resolver is a function, an async generator, a name for one, or a call that returns one, and the bare `t.procedure` is a base procedure only off a plain name in a file that imports `@trpc/server`. Confidence is `high` in a file that imports `@trpc/server` and `medium` elsewhere. `aburi init` now writes `framework-trpc` for a workspace that depends on `@trpc/server`, where it used to report the framework as unmapped. The `@aburi/effects-trpc` README names the new package as the one that covers server-side routers.

  `@aburi/core` exports `receiverChain`, the receiver walk `calleeName` names a call by, with each property and method on the way, and `writtenChildren`, a node's named children without comments. `@aburi/framework-express` reads its arguments through the latter.

### Patch Changes

- Updated dependencies [19ead65]
- Updated dependencies [af4b970]
- Updated dependencies [c6ce311]
- Updated dependencies [b7a7148]
- Updated dependencies [f2a6916]
- Updated dependencies [50ea5bb]
- Updated dependencies [90fa1cb]
- Updated dependencies [b7a7148]
- Updated dependencies [9c21737]
- Updated dependencies [dde9172]
- Updated dependencies [7d4dbf9]
- Updated dependencies [3b52db9]
- Updated dependencies [dfffac9]
- Updated dependencies [ad04fff]
- Updated dependencies [13f8ba9]
- Updated dependencies [1a56ce7]
- Updated dependencies [107c1c6]
- Updated dependencies [b2155c1]
- Updated dependencies [b2155c1]
- Updated dependencies [bb90fea]
- Updated dependencies [f32e45b]
- Updated dependencies [b7a7148]
- Updated dependencies [80be216]
- Updated dependencies [50c0bd2]
- Updated dependencies [a6cd1ac]
- Updated dependencies [f9d300c]
- Updated dependencies [1a41bef]
- Updated dependencies [6be7d2e]
- Updated dependencies [ad21560]
- Updated dependencies [517eb21]
- Updated dependencies [36fd72f]
- Updated dependencies [6afef8b]
- Updated dependencies [eb4ab00]
- Updated dependencies [d4fca12]
- Updated dependencies [635be83]
- Updated dependencies [659f00c]
- Updated dependencies [7830c96]
- Updated dependencies [463d616]
- Updated dependencies [7830c96]
- Updated dependencies [47f8ef9]
- Updated dependencies [65c758f]
  - @aburi/core@0.6.0
  - @aburi/types@0.6.0
