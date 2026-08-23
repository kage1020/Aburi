# Config (`aburi.config.v1`)

Complete specification of `aburi.json`, Aburi's per-project configuration file.
The JSON Schema [`aburi.config.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.config.v1.json) is the single source of truth.

References:
- [`ir-schema.md`](./ir-schema.md) — Component structure
- [`extension-vocab.md`](./extension-vocab.md) — plugin manifests and vocab registration
- [`drop-list.md`](./drop-list.md) — where suppress/keep/frameworkHints take effect
- [`lang-plugin.md`](./lang-plugin.md) / [`effect-plugin.md`](./effect-plugin.md) — plugin enablement

---

## 1. File Format and Placement

- File name: `aburi.json` or `aburi.jsonc`
- Placement: workspace root (same level as `pnpm-workspace.yaml` / `package.json`, etc.).
  A config in a subdirectory is also honoured — discovery walks up from `cwd` (§5.2 of
  [`cli-reference.md`](../cli-reference)) — but every relative path *inside* it (`ignore`,
  `components[].roots`, relative plugin refs) still resolves against the workspace root,
  and the scan still covers the whole workspace. `aburi scan` warns when the two differ.
- Format: JSONC (comments allowed) or JSON
- Encoding: UTF-8, LF
- Indentation: 2 spaces

Why JSONC is allowed: this is a human-authored config, so comments on each section carry value. Generated JSON must be passable to a parser by consumers as-is, so pure JSON is supported too.

`aburi.config.ts` / `aburi.config.yaml` are not adopted (on the premise that AI interprets the config, everything is unified as static JSON).

## 2. Overall Structure

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",

  // File exclusion (drop-list Category A)
  "ignore": ["docs/**", "scripts/legacy/**"],
  "respectGitignore": true,

  // Plugin enablement (extension-vocab §4)
  "languages": ["lang-typescript"],
  "frameworks": ["framework-nestjs"],
  "effects": ["effects-prisma", "effects-pino"],

  // Per-plugin options (optional)
  "pluginOptions": {
    "effects-prisma": { "treatExtendsAsTx": true }
  },

  // Component override (autodetect is the default)
  "components": [
    { "id": "billing", "roots": ["apps/billing"] }
  ],

  // drop-list extension (Category D)
  "suppress": ["myLogger", "metrics"],
  "keep": ["myLogger.audit"],

  // Framework hints (Tier 3 plugin, extension-vocab §11.3)
  "frameworkHints": [
    {
      "name": "acme-framework",
      "decorators": {
        "AcmeController": { "boundary": true, "extKind": "framework:acme:controller" }
      }
    }
  ],

  // Output destination
  "output": {
    "dir": "out"
  },

  // Execution mode
  "strict": true,

  // Resource limits for parsing/extraction
  "maxFileSizeBytes": 2097152,        // 2 MB (default); files exceeding this are skipped
  "parseTimeoutMs": 5000,             // per-file parse+extract+walk budget (default 5s); an over-budget file is skipped whole — lang-plugin.md §7.1.2

  // Coverage floor — absent by default
  "minParsedFileRatio": 0.9           // exit 3 when fewer than 90% of discovered files were parsed — cli-spec.md §5.7
}
```

Every field is optional. Even an empty `{ "$schema": "..." }` works (autodetect does everything).

## 3. `ignore`

Array of glob patterns appended to drop-list Category A.

```jsonc
{
  "ignore": ["docs/**", "scripts/legacy/**", "**/*.fixture.ts"]
}
```

- POSIX globs (forward slashes)
- Relative to the workspace root
- micromatch-compatible

These are **appended** to the core standard patterns of drop-list §3.1 (existing patterns are not replaced).

## 4. `respectGitignore`

```jsonc
{ "respectGitignore": true }
```

- Default: `true`
- Applies the workspace root's `.gitignore` with git's own rules (see drop-list.md §3.3), alongside drop-list Category A

Setting it to `false` makes git-ignored files (build artifacts, etc.) extraction targets as well. Intended for special cases such as deliberately inspecting built code in CI.

## 5. Plugin Enablement

### 5.1 `languages` / `frameworks` / `effects`

```jsonc
{
  "languages": ["lang-typescript"],
  "frameworks": ["framework-nestjs", "framework-next"],
  "effects": ["effects-prisma", "effects-pino", "effects-fetch"]
}
```

Each array element is a **plugin manifest name** (the `name` field).

### 5.2 Resolution Order

For a string `<id>`, Aburi resolves to exactly one specifier — there is no fallback chain:

1. `<id>` starts with `./` or `../` → resolved against the workspace root as a `file:` URL
2. `<id>` is scoped or contains `/` (`@myorg/pkg`, `some-pkg/subpath`) → used verbatim
3. Otherwise → prefixed, becoming `@aburi/<id>`

Examples:
- `"effects-prisma"` → `@aburi/effects-prisma`
- `"@myorg/aburi-effects"` → `@myorg/aburi-effects`
- `"./aburi-plugins/internal-framework.mjs"` → direct relative path

A bare name is therefore *only* resolvable under the `@aburi` scope. Third-party plugins
must be listed by their full package name.

### 5.3 Meaning of Array Order

| Array | Meaning of order |
|---|---|
| `languages` | Order is meaningless (unless extensions collide) |
| `frameworks` | Order is meaningless (unless decorator names etc. collide; on collision, config order wins) |
| `effects` | **Order is priority** (effect-plugin §5.1 first-match-wins) |

Earlier entries in `effects` have higher priority. Placing a project-specific plugin first gives it priority over standard plugins.

### 5.4 `pluginOptions`

Opaque per-plugin configuration.

```jsonc
{
  "pluginOptions": {
    "effects-prisma": { "treatExtendsAsTx": true },
    "framework-nestjs": { "considerHttpExceptionAsThrow": false }
  }
}
```

- Keys are plugin manifest names
- Values are arbitrary objects interpreted by the plugin (the Aburi core does not inspect their contents)
- Each plugin is responsible for documenting the schema of its options

## 6. `components`

Overrides the logical component boundaries of a monorepo.
When not specified explicitly, the core Component autodetect infers them from `pnpm-workspace.yaml` / `turbo.json` / `go.work` / `Cargo.toml` / `pyproject.toml`, etc.

```jsonc
{
  "components": [
    {
      "id": "billing",
      "name": "Billing",
      "roots": ["apps/billing", "packages/billing-domain"],
      "publicApi": [
        "apps/billing/src/routes/**",
        "ts:packages/billing-domain/src/index.ts#Invoice"
      ],
      "frameworks": ["nestjs"]
    }
  ]
}
```

Each field has the same shape as [`ir-schema.md`](./ir-schema.md) §4. **However, `languages` may be omitted on the config side** (when omitted, autodetect fills it in). `name` may also be omitted on the config side, in which case the autodetect result (`package.json#name`, etc.) is used. In the schema, both are required on the IR Component; the config Component is lenient.

### 6.1 Merge Rules

Components explicitly declared in the config **replace** the autodetect results (no merging):

- The config contains component A's id → the autodetect result with the same id is discarded and the config is adopted
- The config does not contain component A's id → the autodetect result is adopted as-is

No ad-hoc merge is provided for "I only want to tweak part of the autodetect result". A component you want to modify must be written out explicitly.

## 7. `suppress` / `keep` (drop-list Extension)

```jsonc
{
  "suppress": ["myLogger", "metrics", "tracer"],
  "keep": ["myLogger.audit", "@Transaction"]
}
```

- `suppress[]`: identifier prefixes. Excludes all of `myLogger.*` from effects/calls
- `keep[]`: exceptional retention. The `@<name>` form denotes a decorator; anything else a callee

Follows the evaluation order of drop-list §6.1 / §6.2 / §7 (keep > suppress > plugin > core).

## 8. `frameworkHints` (Tier 3 Plugin)

A mechanism to declaratively add framework Boundary recognition and extKind mapping with no code at all.
The concrete form of the Tier 3 plugin of extension-vocab §11.3.

```jsonc
{
  "frameworkHints": [
    {
      "name": "acme-framework",
      "decorators": {
        "AcmeController": {
          "boundary": true,
          "extKind": "framework:acme:controller",
          "derivedBy": "framework-hint:acme:controller"
        },
        "AcmeInternal": {
          "boundary": false,
          "drop": true
        }
      },
      "classNamePatterns": {
        "*Handler": {
          "extKind": "framework:acme:handler"
        }
      }
    }
  ]
}
```

### 8.1 `decorators`

Keys are decorator names (the `AcmeController` part of the decorator `@AcmeController`).
Fields of each value:

| Field | Effect |
|---|---|
| `boundary` | Overrides `Decorator.boundary` with this value |
| `extKind` | Sets `Symbol.extKind` for Symbols carrying this decorator |
| `derivedBy` | Appended to `Symbol.derivedBy[]` |
| `drop` | Category-B drop of Symbols carrying this decorator |

All are optional.

### 8.2 `classNamePatterns`

Keys are class-name globs (`*Handler`, `*Service`, `Abstract*`).
Values take the same fields as decorators (`extKind`/`derivedBy`/`drop`; `boundary` is decorator-only).

### 8.3 Automatic Ad-hoc Plugin Conversion

Each `frameworkHints` entry is internally registered as a single ad-hoc plugin:

```
name: hint-<name>
type: framework
provides.extKindPrefixes:  each extKind value's namespace with "hint:" prepended
provides.derivedByPrefixes: likewise
provides.frameworks: [<name>]
```

#### 8.3.1 Namespace Isolation via Automatic `hint:` Prefixing

The user-written `extKind: "framework:acme:controller"` is internally transformed into **`framework:hint:acme:controller`**.
This avoids:

- Collision accidents on the `framework:acme` prefix when an `@aburi/framework-acme` plugin is already installed
- frameworkHints later breaking an existing plugin

The `hint:` prefixing is done transparently by the core, so users keep writing `extKind: "framework:acme:controller"`. It appears in the generated IR and Markdown as `framework:hint:acme:controller`.

Example: `extKind: "framework:acme:controller"` → internally `framework:hint:acme:controller` → `extKindPrefixes: ["framework:hint:acme"]` is inferred automatically.

Users never need to think about prefix declarations.

### 8.4 Collisions

- Multiple entries with the same `name` → config validation error
- Another entry claims the same `extKindPrefixes` (auto-inferred result) → the registry errors at startup (extension-vocab §6.1)
- An existing plugin owns the same namespace → startup error

## 9. `output`

```jsonc
{
  "output": {
    "dir": "out"
  }
}
```

- `dir` (default `"out"`): output destination for IR/Markdown (relative to the workspace root)

Future addition candidates:
- `format`: `"json"` / `"md"` / `"both"` (default `"both"`)
- `compact`: `true` for single-line JSON

Currently only `dir` is supported.

## 10. `strict`

```jsonc
{ "strict": true }
```

- Default: `true`
- When `true`, a plugin emitting vocab not declared in its manifest is an extraction-time error
- When `false` (= making the equivalent of `aburi scan --discover` permanent), it is a warning only and execution continues

The CI default is `true`; use `false` or the CLI's `--discover` when you want discovery in local development.

When both are specified, the CLI flag overrides the config.

## 10.1 `minParsedFileRatio`

```jsonc
{ "minParsedFileRatio": 0.9 }
```

- Absent by default, and absent means no floor rather than a floor of zero
- Range `0 < r <= 1`; a floor of `0` is refused because nothing can fall below it, and a config
  key that cannot change an outcome is a policy that lies
- `aburi scan` exits `3` when `parsedFiles / totalFiles` is **below** it — `<`, not `<=`, so
  exactly the floor passes
- Counts every skip reason, not `parse-timeout` alone: which reason produced the loss decides the
  fix, not whether coverage collapsed

Independent of this key, a scan that discovered nothing, or parsed nothing of what it discovered,
exits `3` — see [`cli-spec.md`](./cli-spec.md) §5.7. The floor is only about the ground between
that and a clean run, which is where the answer depends on the repository.

No CLI flag mirrors it. A coverage floor is a property of the workspace rather than of one
invocation, and a flag would need the key in the config anyway for the CI run to be reproducible.

## 11. Overrides from the CLI

Config values can be overridden by CLI flags:

| CLI flag | Config overridden |
|---|---|
| `--ignore <glob>` | Appended to `ignore[]` |
| `--respect-gitignore` / `--no-respect-gitignore` | `respectGitignore` |
| `--strict` / `--no-strict` | `strict` |
| `--discover` | Equivalent to `strict: false` |
| `--output-dir <path>` | `output.dir` |

See [`cli-spec.md`](./cli-spec.md) for details.

## 12. autodetect (Behavior Without a Config)

When no config exists at all (`aburi.json` is absent), `aburi scan` attempts the following autodetect:

```
Determining the workspace root:
  - Location of the .git directory (or the nearest one when inside a subdirectory)
  - pnpm-workspace.yaml / package.json workspaces / turbo.json / go.work / Cargo.toml workspace

Monorepo detection:
  - Infer components[].roots from the manifests above

Language detection:
  - Determine languages per component from extension frequency

Framework detection:
  - Look for nestjs / next / react / express etc. in package.json dependencies
  - Suggest auto-enabling the `framework-<name>` plugin matching each detected framework (without actually enabling it)
```

Autodetect alone is enough to run, but for stability it is recommended to write the results to `aburi.json` via `aburi init`.

## 13. Output of `aburi init`

`aburi init` writes the autodetect results out as `aburi.json`. Example:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": [],
  "effects": [],
  "components": [
    { "id": "billing", "name": "Billing", "roots": ["apps/billing"], "languages": ["ts"] },
    { "id": "shared",  "name": "Shared",  "roots": ["packages/shared"], "languages": ["ts"] }
  ]
}
```

`init` fills in the language and framework plugin refs it has a mapping for; effects plugins are outside its scope and are added by hand.

## 14. Verifiable Properties

| ID | Input | Expectation |
|---|---|---|
| C1 | A config that is only `{}` | Runs via autodetect |
| C2 | `effects` is an empty array | No effect classification; everything remains in calls |
| C3 | `effects: ["effects-prisma", "effects-stripe"]` | Classification is evaluated in order |
| C4 | Two entries with the same component id | Config validation error |
| C5 | The same callee in both `keep` and `suppress` | keep wins (drop-list §7) |
| C6 | Two `frameworkHints` entries with the same name | Config validation error |
| C7 | Prefixes auto-inferred from `frameworkHints` extKind values | Registered in the registry |
| C8 | Extracting undeclared vocab with `strict: false` | Warning only; recorded in `out/aburi-vocab-discovered.json` |
| C9 | Passing CLI `--strict` | Overrides config `strict: false` |
| C10 | Specifying an unregistered plugin in `pluginOptions` | Warning (ignored because the plugin is disabled) |
| C11 | `minParsedFileRatio` omitted, and a scan that parsed some files and lost others | Exit 0 |
| C12 | `minParsedFileRatio: 0.9`, and a scan that parsed half the files it found | Exit 3, naming both counts and the floor |
| C13 | `minParsedFileRatio` equal to the ratio the scan achieved | Exit 0 |
| C14 | `minParsedFileRatio: 0` | Config validation error |

## 14.1 Config Schema Compatibility Policy

The compatibility of `aburi.config.v1.json` follows the same policy as the IR schema (ir-schema.md §15).
Particularly important:

- The **contents of `pluginOptions` values** are managed by each plugin's own schema and are outside the compatibility scope of the Aburi core
- Adding fields to `frameworkHints` is non-breaking
- Changing the default values of `output.dir` / `strict` is treated as **breaking** (behavior changes in CI, so it goes to v2)

## 15. Design Decisions

### 15.1 Why Explicit Plugin Enablement Is Adopted

There is an "implicit" alternative — scanning `node_modules` and auto-loading anything with an `aburi-plugin.json` — but it is rejected to avoid:

- A single rogue package influencing Aburi's output
- Developers struggling to trace "why is this effect appearing"
- Unpredictable vocab collisions

Explicit enablement is used uniformly. `aburi init` proposes and writes candidates from the package.json dependencies, so the manual burden is effectively zero.

### 15.2 Why Plugin Names Are Manifest Names

Using npm package names (`@aburi/effects-prisma`) alongside manifest names (`effects-prisma`) makes naming redundant. The config is more readable written with short manifest names. Aburi trying `@aburi/<name>` during npm resolution preserves the DX of official plugins.

### 15.3 Why `pluginOptions` Is an Opaque Object

Controlling each plugin's behavior is the plugin's responsibility. If the Aburi core enforced a schema, plugin evolution would slow down.

Instead, each plugin documents its own `pluginOptions` schema, and users consult the plugin docs.

### 15.4 Why `components` Merging Is Not Supported

Ad-hoc merging causes the accident where "I wrote a config, but a change in autodetect behavior silently changed the values". By standardizing on **replacement**, the behavior of a written config is predictable independently of autodetect changes.

### 15.5 Automatic Prefix Inference for `frameworkHints`

Making users hand-write `extKindPrefixes: ["framework:acme"]` is redundant and error-prone. Auto-inferring from `extKind` values lets a Tier 3 plugin come together with minimal code.

### 15.6 Why `aburi.config.ts` Is Not Adopted

- On the premise that AI consumers read the config, static JSON is overwhelmingly easier to handle
- TypeScript completion is fully achievable via JSON Schema (`$schema`) — the `biome.json` / `tsconfig.json` worldview
- The need for dynamic logic (e.g. deciding suppress via a function) is low; when needed, writing a plugin has higher reusability
