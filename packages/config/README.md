# @aburi/config

`aburi.json` / `aburi.config.jsonc` loader. Parses JSONC, validates against
`aburi.config.v1` with ajv strict mode, and normalises `frameworkHints`
(`hint:*` prefixes) into synthetic plugin manifests for hint-declared vocab that
does not need a physical plugin package.

The loader is workspace-aware: `loadConfig({ cwd })` walks up looking for a
config file the same way the CLI's `aburi scan` does.

## Install

```bash
pnpm add @aburi/config
```

## Usage

```ts
import { loadConfig, readConfigFile } from "@aburi/config"

const loaded = await loadConfig({ cwd: process.cwd() })
loaded.config       // validated Config
loaded.filePath     // absolute path, or null when defaulting
loaded.syntheticPlugins  // manifests derived from frameworkHints
```

Direct file read (skip discovery):

```ts
const { config, syntheticPlugins } = await readConfigFile("./aburi.json")
```

Ajv errors are surfaced with a stable `ConfigValidationError` shape so callers
can render them without parsing ajv message strings.

## See also

- [`schema/aburi.config.v1.json`](../../schema/aburi.config.v1.json)
- [`design/details/config.md`](../../design/details/config.md)
