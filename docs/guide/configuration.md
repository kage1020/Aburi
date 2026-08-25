# Configuration

`aburi init` writes an `aburi.json` at your workspace root, and for most
projects that generated file is the last you will think about it:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": ["framework-nestjs"]
}
```

Every field is optional — even `{}` works, because autodetect fills in the rest.
The sections below cover the things people actually end up changing.

::: tip JSONC is fine
Name the file `aburi.jsonc` if you want comments. Keep the `$schema` line either
way; it gives you completion and validation in most editors.
:::

## Exclude files

Generated code, vendored trees, and fixtures rarely belong in the report.

```jsonc
{
  "ignore": ["src/generated/**", "test/fixtures/**", "**/*.pb.ts"]
}
```

Patterns are POSIX globs relative to the workspace root, and they *add* to the
built-in exclusions rather than replacing them.

`.gitignore` is honoured by default — every one in the tree, the way git reads
them. Turn it off only when you deliberately want to analyse build output:

```jsonc
{ "respectGitignore": false }
```

## Choose plugins

Three lists, one per plugin kind:

```jsonc
{
  "languages": ["lang-typescript"],
  "frameworks": ["framework-nestjs", "framework-next"],
  "effects": ["effects-prisma", "effects-nest"]
}
```

A bare name resolves under the `@aburi` scope, so `"effects-prisma"` means
`@aburi/effects-prisma`. Third-party plugins need their full package name
(`"@myorg/aburi-effects"`), and a path starting with `./` loads a local file.

Order matters in `effects` only: the first plugin to recognise a call wins, so
put project-specific plugins first. Options for an individual plugin go under
`pluginOptions`, keyed by plugin name:

```jsonc
{
  "pluginOptions": {
    "effects-prisma": { "treatExtendsAsTx": true }
  }
}
```

## Define components

Components are the boxes in `workspace.md` and the unit `components/*.md` is
written per. Aburi infers them from your workspace manifests; declare them
explicitly when the inference does not match how you think about the codebase:

```jsonc
{
  "components": [
    {
      "id": "billing",
      "name": "Billing",
      "roots": ["apps/billing", "packages/billing-domain"],
      "publicApi": ["apps/billing/src/routes/**"]
    }
  ]
}
```

A declared component **replaces** the autodetected one with the same id — there
is no partial merge, so write out every field you care about. Components you do
not mention keep their autodetected definition.

## Quiet down noisy helpers

Logging and metrics calls tend to appear in every symbol without saying much.
`suppress` takes identifier prefixes and drops them from effects and calls;
`keep` carves exceptions back out, and wins over everything:

```jsonc
{
  "suppress": ["myLogger", "metrics"],
  "keep": ["myLogger.audit", "@Transaction"]
}
```

An entry starting with `@` in `keep` names a decorator; anything else names a
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

For anything more involved — parsing a new language, recognising call shapes —
write a [plugin](/extend/plugin-development) instead.

## Move the output

```jsonc
{ "output": { "dir": "reports/aburi" } }
```

`scan` and `diff` write there, and `explain` reads the analysis back from there.
The `--output-dir` flag wins over this when both are given.

## Limits

The defaults suit a normal repository. Reach for these when a scan is slow, or
when it silently skips files you expected to see:

```jsonc
{
  "maxFileSizeBytes": 2097152,
  "parseTimeoutMs": 5000,
  "classifyTimeoutMs": 50,
  "minParsedFileRatio": 0.9
}
```

`minParsedFileRatio` is the one with teeth and has no default: set it, and a
scan that parsed less than that share of the files it discovered exits `3`
instead of quietly reporting on a fraction of your code. Worth setting in CI.

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
| `output.dir` | `out` | Where artifacts are written and read back. |
| `strict` | `true` | Abort when a plugin emits vocabulary it never declared. |
| `maxFileSizeBytes` | `2097152` | Files above this size are skipped. |
| `parseTimeoutMs` | `5000` | Per-file budget for parse, extract, and walk. |
| `classifyTimeoutMs` | `50` | Per-call budget for an effects plugin. |
| `minParsedFileRatio` | *(unset)* | Smallest share of discovered files a scan may parse and still pass. |
| `lsp` | off | Optional type-aware enrichment. Not implemented yet. |

The [JSON Schema](https://github.com/kage1020/Aburi/blob/main/schema/aburi.config.v1.json)
is the authoritative definition, and the [config design doc](/design/config)
carries the reasoning behind each field.
