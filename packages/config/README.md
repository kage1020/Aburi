# @aburi/config

`aburi.json` / `aburi.jsonc` loader. Parses JSONC, validates against
`aburi.config.v1` with ajv strict mode, and normalises `frameworkHints` into
synthetic plugin manifests for hint-declared vocab that does not need a
physical plugin package.

The loader is workspace-aware: `loadConfig({ cwd })` walks up from `cwd`
looking for `aburi.jsonc` first, then `aburi.json`, and falls back to the
autodetect variant when neither is found.

## Install

```bash
pnpm add @aburi/config
```

## Usage

```ts
import { loadConfig, readConfigFile, ConfigError } from "@aburi/config"

const loaded = await loadConfig({ cwd: process.cwd() })
if (loaded.found) {
  loaded.source           // absolute path to the config file
  loaded.config           // validated Config
  loaded.syntheticPlugins // manifests derived from frameworkHints
} else {
  // No aburi.json / aburi.jsonc on disk. `loaded.config` is `{}` and
  // `loaded.syntheticPlugins` is `[]`; the caller runs autodetect.
}
```

`LoadedConfig` is a discriminated union keyed by `found` so callers narrow with
`if (loaded.found) { … }` before touching `loaded.source` / `loaded.config`.
Skipping the narrow is a type error, which was the point — a "did you forget
the autodetect branch?" bug is easier to catch at compile time than in prod.

Direct file read (skip discovery, no autodetect fallback):

```ts
const config = await readConfigFile("./aburi.json")
// → validated Config only. `syntheticPlugins` is only produced by loadConfig,
//   because normalisation is workspace-aware.
```

Errors surface as `ConfigError` with a stable `code` field so callers can
distinguish (for example) `parse-error` from `schema-violation` without parsing
ajv message strings.

## Framework hints

`config.frameworkHints[].vocab[].extKind` values written as
`framework:<vendor>:<rest>` are automatically rewritten to
`framework:hint:<vendor>:<rest>` by the loader — the `hint` segment is inserted
at position 2 to reserve the namespace for user-declared vocab, so a hint can
never collide with a real plugin's `framework:<vendor>:*` claim. Writing the
`hint:` segment directly in your config throws with a "remove the `hint:`
segment and let the loader add it" error.

## See also

- [`schema/aburi.config.v1.json`](../../schema/aburi.config.v1.json)
- [`design/details/config.md`](../../design/details/config.md)
