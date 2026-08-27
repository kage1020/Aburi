---
"@aburi/types": minor
"@aburi/config": minor
"@aburi/core": minor
"@aburi/diff": minor
"@aburi/cli": minor
"@aburi/plugin-registry": minor
"@aburi/lang-typescript": minor
"@aburi/framework-express": minor
"@aburi/framework-nestjs": minor
"@aburi/framework-next": minor
"@aburi/framework-react": minor
"@aburi/effects-drizzle": minor
"@aburi/effects-nest": minor
"@aburi/effects-prisma": minor
"@aburi/effects-trpc": minor
---

Point every schema id at the documentation domain

The four JSON Schemas identified themselves as `https://aburi.dev/schema/...`, a host this
project does not own and never served them from. The docs site is `aburi.kage1020.com`, so
that is the name the `$id`s, the `$schema` `const`s, the `$schema` an `aburi init` writes,
and the plugin manifests now carry.

`$schema` is validated with a `const`, so an `aburi.json` or a plugin manifest still naming
the old host is rejected until the string is updated — a find-and-replace of
`aburi.dev/schema` with `aburi.kage1020.com/schema`, or a re-run of `aburi init --force`.
