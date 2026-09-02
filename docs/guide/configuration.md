# Configuration

`aburi init` writes an `aburi.json` at your workspace root, and for most
projects that generated file is the last you will think about it:

```jsonc
{
  "$schema": "https://aburi.kage1020.com/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": ["framework-next", "framework-react"]
}
```

Every field is optional. Even `{}` works, because autodetect fills in the rest.
The sections below cover what people change in practice.

::: tip JSONC is fine
Name the file `aburi.jsonc` if you want comments. Keep the `$schema` line either
way. It gives you completion and validation in most editors.
:::

## Exclude files

Generated code, vendored trees, and fixtures rarely belong in the report.

```jsonc
{
  "ignore": ["src/generated/**", "test/fixtures/**", "**/*.pb.ts"]
}
```

Write POSIX globs relative to the workspace root. Aburi adds them to the
built-in exclusions rather than replacing them.

Aburi honours `.gitignore` by default, every one in the tree, the way git reads
them. Turn that off when you want to analyse build output on purpose:

```jsonc
{ "respectGitignore": false }
```

## Choose plugins

Three lists, one per plugin kind:

```jsonc
{
  "languages": ["lang-typescript"],
  "frameworks": ["framework-next", "framework-react"],
  "effects": ["effects-drizzle"]
}
```

A bare name resolves under the `@aburi` scope, so `"effects-drizzle"` means
`@aburi/effects-drizzle`. Third-party plugins need their full package name
(`"@myorg/aburi-effects"`), and a path starting with `./` loads a local file.

Order matters in `effects` alone. The first plugin to recognise a call wins, so
put your project-specific plugins first. Options for an individual plugin go
under `pluginOptions`, keyed by plugin name:

```jsonc
{
  "pluginOptions": {
    "effects-prisma": { "treatExtendsAsTx": true }
  }
}
```

## Define components

Components are the boxes in `workspace.md`, and the unit Aburi writes each
`components/*.md` for. It infers them from your workspace manifests. Declare
them yourself when that inference does not match how you think about the
codebase:

```jsonc
{
  "components": [
    {
      "id": "checkout",
      "name": "Checkout",
      "roots": ["apps/storefront/src/app/checkout", "packages/pricing"],
      "publicApi": ["packages/pricing/src/index.ts"]
    }
  ]
}
```

A component you declare **replaces** the autodetected one with the same id.
There is no partial merge, so write out every field you care about. Components
you leave alone keep their autodetected definition.

`roots` is also what decides which component a symbol counts towards: a file
belongs to the component whose root is the deepest directory containing it, so
a component rooted at `apps/storefront/src/app/checkout` takes those files back
from one rooted at `apps/storefront`. A file under no root at all — `scripts/`
beside your packages, say — belongs to no component, and appears in
`workspace.md` and the diff but in no `components/*.md`.

## Quiet down noisy helpers

Logging and metrics calls show up in almost every symbol without telling you
much. `suppress` takes identifier prefixes and drops them from effects and
calls. `keep` carves exceptions back out, and beats everything else:

```jsonc
{
  "suppress": ["myLogger", "metrics"],
  "keep": ["myLogger.audit", "@Transaction"]
}
```

An entry starting with `@` in `keep` names a decorator. Anything else names a
callee.

## Teach it your in-house framework

If your team has its own decorators, you can get boundary detection without
writing a plugin:

```jsonc
{
  "frameworkHints": [
    {
      "name": "acme",
      "decorators": {
        "AcmeController": { "boundary": true, "extKind": "framework:acme:controller" }
      },
      "classNamePatterns": {
        "*Handler": { "extKind": "framework:acme:handler" }
      }
    }
  ]
}
```

For anything heavier, such as parsing a new language or recognising call shapes,
write a [plugin](../extend/plugin-development.md) instead.

## Move the output

```jsonc
{ "output": { "dir": "reports/aburi" } }
```

`scan` and `diff` write there, and `explain` reads the analysis back from there.
The `--output-dir` flag beats this setting when you pass both.

## Limits

The defaults suit a normal repository. Reach for these when a scan drags, or
when it skips files you expected to see:

```jsonc
{
  "maxFileSizeBytes": 2097152,
  "parseTimeoutMs": 5000,
  "classifyTimeoutMs": 50,
  "minParsedFileRatio": 0.9
}
```

`minParsedFileRatio` is the one with teeth, and it has no default. Set it, and a
scan that parsed less than that share of the files it discovered exits `3`
rather than reporting on a fraction of your code without saying so. Worth
setting in CI.

## All fields

| Field | Default | Purpose |
|---|---|---|
| `ignore` | `[]` | Extra glob patterns to skip. |
| `respectGitignore` | `true` | Honour `.gitignore` files. |
| `languages` | autodetect | Language plugins to load. |
| `frameworks` | autodetect | Framework plugins to load. |
| `effects` | autodetect | Effects plugins, in priority order. |
| `pluginOptions` | `{}` | Per-plugin options, keyed by plugin name. |
| `components` | autodetect | Explicit component boundaries. |
| `suppress` | `[]` | Identifier prefixes to drop from effects and calls. |
| `keep` | `[]` | Exceptions to `suppress` and to the built-in drop rules. |
| `frameworkHints` | `[]` | Decorator and class-name rules for an in-house framework. |
| `output.dir` | `out` | Where Aburi writes artifacts and reads them back. |
| `strict` | `true` | Abort when a plugin emits vocabulary it never declared. |
| `maxFileSizeBytes` | `2097152` | Aburi skips files above this size. |
| `parseTimeoutMs` | `5000` | Per-file budget for parse, extract, and walk. |
| `classifyTimeoutMs` | `50` | Per-call budget for an effects plugin. |
| `minParsedFileRatio` | *(unset)* | Smallest share of discovered files a scan may parse and still pass. |
| `lsp` | off | Optional type-aware enrichment. Not implemented yet. |

The [JSON Schema](https://aburi.kage1020.com/schema/aburi.config.v1.json) is the
authoritative definition — that URL is the one the `$schema` line points at, and it
serves the same file the loader validates against. The
[config design doc](../design/config.md) carries the reasoning behind each field.
