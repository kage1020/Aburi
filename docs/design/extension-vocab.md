# Extension Vocabulary Registry

While Aburi's core schema has a vocabulary fixed by strict enums, language/framework/effect plugins have an extensible "loose" vocabulary. This document defines the registration mechanism for that extension vocabulary.

See: [`ir-schema.md`](./ir-schema.md) §5.2 / §9.2 / §16
Plugin manifest: [`aburi.plugin.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.plugin.v1.json)

---

## 1. Purpose

Reasons for organizing the extension vocabulary:

- **Discoverability**: make it possible to query what is registered in a given Aburi installation (CLI / diff renderer / IR consumers)
- **Validation**: verify at runtime that the extKind / effect.id values a plugin generates stay within what its manifest declared
- **Documentation**: hold, in machine-readable form, what each extension value "means"
- **Conflict detection**: stop with an error when two or more plugins declare the same identifier

Schema-level validation ([`aburi.ir.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.ir.v1.json)) only guarantees pattern matching. Deciding semantically whether "this value may be used in this project" is the responsibility of this registry.

## 2. Extension targets (4 kinds)

| Target | Location in the IR | Format |
|---|---|---|
| `extKind` | `Symbol.extKind` | `<ns>(:<segment>)+` |
| Effect id (extension) | `Symbol.effects[].id` | `x-<ns>:<action>` |
| `derivedBy` strings | `Symbol.derivedBy[]` | free-form (convention: `<ns>:<reason>`) |
| Framework names | `Component.frameworks[]` | `[a-z][a-z0-9-]*` |

The vocabulary is declared via the manifest described in §3 of this document.

## 3. Plugin manifest

Each plugin has exactly **one manifest**, in which it declares its name, its type, and all vocab it provides.

### 3.1 Format

The manifest lives in the `aburi` property of `package.json`, or in a standalone `aburi-plugin.json`. If both exist, the former takes precedence.

```jsonc
// type=effects plugin (effects only, e.g. lifecycle hooks)
{
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
  "name": "effects-nest",
  "version": "1.0.0",
  "type": "effects",
  "xPrefix": "nest",                            // owns x-nest:* (§5.2)
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [                                // individual enumeration
      { "id": "x-nest:lifecycle.on-module-init", "description": "..." }
    ],
    "effectPrefixes": [],                        // wildcard ownership (§3.3)
    "extKinds": [],                              // type=effects may not declare extKinds
    "extKindPrefixes": [],
    "derivedByPrefixes": ["effects-plugin:nest"],
    "frameworks": []                             // type=effects may not declare frameworks
  }
}

// type=framework plugin (boundary recognition, extKind assignment)
{
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
  "name": "framework-nestjs",
  "version": "1.0.0",
  "type": "framework",
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [],                               // type=framework may not declare effects
    "effectPrefixes": [],
    "extKinds": [
      { "id": "framework:nestjs:controller", "baseKind": "class", "description": "..." }
    ],
    "extKindPrefixes": ["framework:nestjs"],
    "derivedByPrefixes": ["framework:nestjs"],
    "frameworks": ["nestjs"]
  }
}
```

As official npm packages these are split into two: `@aburi/effects-nest` and `@aburi/framework-nestjs`.

### 3.2 Individual enumeration vs prefix ownership

There are two styles of vocab declaration:

| Style | Form | Use |
|---|---|---|
| Individual enumeration | `effects: [{id, description}]` | Values are finite and stable, with high documentation value (published plugins) |
| Prefix ownership | `effectPrefixes: ["x-acme"]` | Values change frequently / are numerous / plugin under iterative development |

Both may be combined. With `effects: [{id: "x-acme:explicit"}]` + `effectPrefixes: ["x-acme"]`, the plugin owns all of `x-acme:*`, and `x-acme:explicit` additionally resolves to its individual description.

### 3.3 Prefix format

- Elements of `effectPrefixes[]` match `^x-[a-z][a-z0-9-]*$` (no trailing `:`; a following `:<action>` is implied)
- Elements of `extKindPrefixes[]` match `^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$` (**at least 2 segments required**, i.e. `<ns>:<sub-ns>` or deeper)

The 2-segment minimum on `extKindPrefixes` is deliberate. Allowing single-segment ownership such as bare `framework` would let multiple framework plugins fight over the same top-level namespace, breaking the registry's prefix exclusivity. Including the plugin name, as in `<ns>:<plugin-id>`, lets `framework:nestjs` and `framework:fastify` coexist.

A prefix means "one or more namespace segments owned by this plugin". A plugin declaring `extKindPrefixes: ["framework:acme"]` may freely emit `framework:acme:controller` / `framework:acme:job` etc. at runtime.

### 3.4 Identifier conventions

| Field | Format |
|---|---|
| `name` | `^[a-z][a-z0-9-]*$` |
| `version` | semver |
| `type` | `lang` / `effects` / `framework` |
| `provides.effects[].id` | `^x-[a-z][a-z0-9-]*:[a-z][a-z0-9.-]+$` |
| `provides.effectPrefixes[]` | `^x-[a-z][a-z0-9-]*$` |
| `provides.extKinds[].id` | `^[a-z][a-z0-9-]*(:[a-z][a-z0-9.-]*)+$` |
| `provides.extKindPrefixes[]` | `^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$` |
| `provides.extKinds[].baseKind` | IR `SymbolKind` enum |
| `provides.derivedByPrefixes[]` | `^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$` |
| `provides.frameworks[]` | `^[a-z][a-z0-9-]*$` |

These are machine-validated by [`aburi.plugin.v1.json`](https://github.com/kage1020/Aburi/blob/main/schema/aburi.plugin.v1.json).

## 4. Registration lifecycle

```
aburi startup
  ↓ read the plugin lists from config.effects / frameworks / languages
  ↓ resolve each plugin (npm resolution, or an in-project path)
  ↓ obtain the manifest (§3) and schema-validate it against aburi.plugin.v1.json
  ↓ register in the registry (conflict resolution, §6)
  ↓ start the extraction pipeline
  ↓ during extraction, the registry verifies every extKind / effect.id a plugin returns:
    is it declared / under an owned prefix?
       not covered → exit with an error (plugin implementation bug)
       with the --discover flag → warn only and continue, record in aburi-vocab-discovered.json (§11.5)
```

Plugins not listed in the config are not loaded. Explicit opt-in.

## 5. Namespaces

### 5.1 Central reservations (no plugin may declare these)

| Prefix | Purpose |
|---|---|
| `core:*` | The Aburi core engine itself |
| `aburi:*` | Aburi's own metadata |
| `_:*` | Testing/reserved |
| `framework:hint:*` | Auto-prepended for `frameworkHints` (Tier 3) (§11.3). npm plugins may not declare it |

### 5.2 Ownable namespaces by type

| Prefix | Ownable by `type` | Notes |
|---|---|---|
| `fp:*` | `lang` only | 1 ns = 1 language paradigm; sub-namespaces are individually owned by plugins |
| `oop:*` | `lang` only | Same as above |
| `meta:*` | `lang` only | Same as above |
| `framework:*` | `framework` only | Sub-namespaces (`framework:nestjs:`) are individually owned by plugins |
| `x-*` | `effects` only | `x-<xPrefix>:` form. `xPrefix` is declared explicitly in the manifest (default: `name` with the `effects-` prefix removed, e.g. `effects-prisma` → `prisma`) |

There is **no** distinction between "official plugins" and "third-party". Ownership is manifest-declaration based; conflicts are detected at startup.

### 5.3 Exclusive ownership of sub-namespaces

The `framework:` prefix is shared by multiple `type: framework` plugins, but each sub-namespace (`framework:nestjs:` / `framework:react:`) is exclusively owned by the single plugin that declared it.

The same applies to `fp:` / `oop:` / `meta:`: each sub-namespace is owned by exactly one plugin.

## 6. Conflict resolution

### 6.1 Duplicate declarations

| Situation | Behavior |
|---|---|
| Two plugins declare the same `effects[].id` | **startup error** |
| Two plugins declare the same `extKinds[].id` | **startup error** |
| Two plugins declare the same `effectPrefixes[]` | **startup error** |
| Two plugins declare the same `extKindPrefixes[]` | **startup error** |
| Two plugins declare the same `frameworks[]` name | **startup error** |
| Two plugins declare the same `derivedByPrefixes[]` | **startup error** |
| Plugin A declares `extKinds[].id: "framework:acme:job"` and plugin B declares `extKindPrefixes: ["framework:acme"]` | **startup error** (B's prefix subsumes A's id) |
| A `type` other than `effects` declares `x-*` | **startup error** |
| A `type` other than `lang` declares `fp:*` / `oop:*` / `meta:*` | **startup error** |
| A `type` other than `framework` declares `framework:*` | **startup error** |
| The prefix part of `x-<prefix>` does not match `xPrefix` (default: `name` with `effects-` removed) | **manifest validation error** |
| A `type: effects` plugin declares `extKinds` / `extKindPrefixes` / `frameworks` | **manifest validation error** (schema if/then) |
| A `type: framework` plugin declares `effects` / `effectPrefixes`, or declares extKinds outside the `framework:` prefix | **manifest validation error** |
| A `type: lang` plugin declares `effects` / `effectPrefixes` / `frameworks`, or declares extKinds outside `(fp\|oop\|meta):` | **manifest validation error** |

Mitigation: forcing the plugin namespace via `x-<plugin-name>:` naturally resolves effect-id conflicts between third parties.

### 6.2 Violating central reservations

Any declaration that includes a centrally reserved namespace from §5.1, at either the prefix or the id level → **startup error**.

### 6.3 Undeclared values at extraction time

If a plugin's extraction logic generates an extKind / effect.id not declared in the registry → the entire extraction **exits with an error**.

This is a fail-safe against "a plugin silently starts using new vocabulary and breaks time-series comparison".

Exception: only under the `aburi scan --discover` flag is this downgraded to a warning and recorded (§11.5).

## 7. Registry API (consumer side)

```ts
interface VocabRegistry {
  // lookup (direct by id, or via an owned prefix)
  findEffect(id: string): EffectVocab | null
  findExtKind(id: string): ExtKindVocab | null
  findFramework(name: string): FrameworkVocab | null
  findDerivedByOwner(value: string): PluginManifest | null

  // ownership checks
  isEffectOwnedBy(id: string, pluginName: string): boolean
  isExtKindOwnedBy(id: string, pluginName: string): boolean

  // enumeration
  listEffects(): EffectVocab[]
  listExtKinds(): ExtKindVocab[]
  listFrameworks(): FrameworkVocab[]
  listPlugins(): PluginManifest[]

  // validation (at extraction time)
  assertEffectDeclared(id: string, byPlugin: string): void
  assertExtKindDeclared(id: string, byPlugin: string): void
}
```

`findEffect("x-acme:custom-action")` returns the entry with its description when `x-acme:custom-action` is individually enumerated; if it is covered only by prefix ownership, it returns the owning plugin's information with description=null.

## 8. CLI (future use)

The `aburi vocab` subcommand (specified in [`cli-spec.md`](./cli-spec.md)):

```bash
aburi vocab list                                       # show all vocab
aburi vocab effects                                    # effect ids only
aburi vocab plugins                                    # list plugins
aburi vocab who-owns x-nest:lifecycle.on-module-init   # the plugin that owns this id
```

## 9. Verifiable properties (test criteria)

| ID | Input | Expected |
|---|---|---|
| V1 | Load a single plugin's manifest | All vocab registered in the registry |
| V2 | Two plugins declare the same effect id | startup error |
| V3 | Two plugins declare the same extKind | startup error |
| V4 | Declaring a central reservation (`core:foo`) | startup error |
| V5 | `type: effects` declares `framework:foo:bar` | startup error |
| V6 | Plugin extraction returns an undeclared effect id (strict mode) | extraction error |
| V7 | Plugin extraction returns an undeclared extKind (strict mode) | extraction error |
| V8 | `name: stripe` declares the `x-acme:` prefix | manifest validation error |
| V9 | Loading the same manifest twice | idempotent |
| V10 | Emitting `x-acme:anything` at extraction time under a declared `effectPrefixes: ["x-acme"]` | passes |
| V11 | A declares `extKinds[].id: "framework:acme:job"`, B declares `extKindPrefixes: ["framework:acme"]` | startup error (subsumption conflict) |
| V12 | Emitting undeclared values under `aburi scan --discover` | warning only; recorded in `aburi-vocab-discovered.json` |
| V13 | Treating `@Foo` as a boundary via Framework hints (§11.3) alone | OK; no plugin manifest required |

## 9.5 Manifest schema compatibility policy

`aburi.plugin.v1.json` adopts the same compatibility policy as the IR schema ([`ir-schema.md`](./ir-schema.md) §15):

| Change | Compatibility |
|---|---|
| Adding a required field | Breaking (to v2) |
| Adding an optional field | Non-breaking |
| Adding an enum value (to the extent consumers tolerate unknowns) | Non-breaking |
| Removing an enum value | Breaking |
| Tightening a pattern | Breaking |
| Loosening a pattern | Non-breaking |
| Adding an array uniqueness constraint | Breaking |

Since consumers may treat unknown values of the `type` enum (`lang` / `effects` / `framework`) as errors, additions to it are also treated as breaking.

## 10. Design decisions

### 10.1 Abolishing "official vs third-party"

Aburi cannot tell whether a plugin is published on npm or local to a repository. Ownership determination is unified on manifest declarations.

### 10.2 IR files themselves may contain undeclared values

An IR consumer (e.g. running the Markdown renderer in a different environment) may not have the plugins used at generation time. The registry guard applies only at generation time; an IR file is valid as long as it satisfies the schema patterns.

### 10.3 Why central reservations are hardcoded

If the reservation list could be changed dynamically via config, an IR generated at one point in time could be judged a "reservation conflict" in a different environment. Each Aburi version carries a fixed reservation list.

### 10.4 Why prefix ownership is allowed

For in-house frameworks and experimental plugins, where the vocab changes frequently or is large, forcing individual enumeration would break the development loop. Prefix ownership lets a plugin assert only "ownership of the namespace" and leaves the contents to runtime, providing flexibility.

### 10.5 Purpose of `derivedByPrefixes`

`derivedBy[]` is a string that lets IR consumers know which plugin made a given determination. Registering prefixes in the registry lets the Markdown renderer control display, e.g. rendering `framework:nestjs:*` derivedBy entries as "NestJS plugin".

---

## 11. Support for minor languages and custom plugins

There are three tiers, by complexity, for bringing a new language / in-house framework / one-off custom rule into Aburi.

### 11.1 Tier 1: Published plugin

- Published on npm, `type: lang | effects | framework`
- Vocab should be **individually enumerated** as a rule (discoverability, documentation value)
- Examples: `@aburi/effects-nest`, `@aburi/lang-typescript`

### 11.2 Tier 2: Project plugin

- Local code inside the repository (e.g. `aburi-plugins/internal-framework.mjs`)
- Referenced via a `package.json` workspace or a direct path in the config
- The manifest format is exactly the same as Tier 1
- **Vocab may use prefix ownership** (§3.3)
- Example:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
  "name": "acme-framework",
  "version": "0.0.1",
  "type": "framework",
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [],
    "effectPrefixes": [],
    "extKinds": [],
    "extKindPrefixes": ["framework:acme"],
    "derivedByPrefixes": ["framework:acme"],
    "frameworks": ["acme-framework"]
  }
}
```

It may freely emit `framework:acme:controller` / `framework:acme:job` / `framework:acme:saga` etc. at runtime.

### 11.3 Tier 3: Framework hints (no code required)

- Declarations inside `aburi.json` only; no code whatsoever
- Covers needs like "treat `@MyDecorator` as a boundary" or "treat `class *Handler` as `framework:mycorp:handler`"
- Specified in [`config.md`](./config.md); this document only shows the hook point
- **A user-written `extKind: "framework:acme:controller"` is automatically converted internally to `framework:hint:acme:controller`** (details in [`config.md`](./config.md) §8.3.1). By transparently inserting `hint:` as the second segment, the core avoids namespace conflicts with an existing official npm `framework-acme` plugin
- A user directly entering `extKind: "framework:hint:*"` is a **config validation error** (rejected by `config-check.mjs`)
- The whole of `framework:hint:*` is a **centrally reserved namespace** (§5.1); third-party npm plugins may not declare it
- Sketch:

```jsonc
{
  "frameworkHints": [
    {
      "name": "acme-framework",
      "decorators": {
        "AcmeController": { "boundary": true, "extKind": "framework:acme:controller" },
        "AcmeJob":        { "boundary": true, "extKind": "framework:acme:job" }
      },
      "classNamePatterns": {
        "*Handler": { "extKind": "framework:acme:handler" }
      }
    }
  ]
}
```

Aburi core treats this internally as an **ad-hoc plugin** and auto-registers the `framework:acme:*` vocab. No code extraction logic is required.

### 11.4 Choosing a tier

| Situation | Recommended tier |
|---|---|
| A published language / framework in wide use | Tier 1 |
| An in-house / project-specific framework that needs effect-detection logic | Tier 2 |
| Only simple classification, e.g. treating `@MyDecorator` as a boundary | Tier 3 |
| Supporting a minor language (Crystal/Zig etc.) | Tier 1 or Tier 2 (tree-sitter grammar + extraction logic required) |
| Plugin under iterative development, vocab not yet settled | Tier 2 + `--discover` (§11.5) |

### 11.5 For development iteration: `--discover` mode

```bash
aburi scan --discover
```

- Even when plugin extraction emits values not declared in the registry, this is not an error: a warning is issued and the value is recorded in `out/aburi-vocab-discovered.json`
- The developer inspects the record and decides whether to promote entries into the manifest
- The CI default is strict (no `--discover`); discover is recommended for local development only

#### 11.5.1 `aburi-vocab-discovered.json` format

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.vocab-discovered.v1.json",   // does not exist in v0.1; formalized in v0.2
  "discoveredAt": "2026-06-21T15:30:00Z",
  "items": [
    {
      "kind": "effect",                       // "effect" | "extKind" | "framework"
      "value": "x-prisma:bulk-delete",
      "firstSeenBy": "effects-prisma",        // the plugin that first generated this value
      "alsoSeenBy": [],                       // other plugins that generated the same value in the same run (rare)
      "occurrences": 3,                       // occurrence count within the run (after dedupe)
      "samples": [                            // the first 3 occurrences
        { "file": "apps/billing/src/x.ts", "line": 42, "symbol": "ts:apps/billing/src/x.ts#foo" }
      ]
    }
  ]
}
```

- `firstSeenBy`: when multiple plugins generate the same undeclared value in one run, the first plugin owns it
- `alsoSeenBy`: subsequent plugins are downgraded to warnings and appended to the record
- `occurrences`: duplicates of the same (value, plugin) pair within a run are deduped with count++

This makes it mechanically decidable at promote time which plugin's manifest an entry should be added to.

### 11.6 Minimal manifest example for a minor-language plugin

If `lang-crystal` were hypothetically written, it could get by on the core vocabulary alone without adding any vocab:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
  "name": "lang-crystal",
  "version": "0.1.0",
  "type": "lang",
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [],
    "effectPrefixes": [],
    "extKinds": [],
    "extKindPrefixes": [],
    "derivedByPrefixes": ["lang:crystal"],
    "frameworks": []
  }
}
```

It simply projects Crystal's `class` / `module` / `def` onto the IR core enum (`class` / `module` / `function`) without using `extKind`. The vocab declaration burden is near zero.

When special concepts (`fp:macro`, `oop:abstract`, etc.) become desirable, add the corresponding prefix to `extKindPrefixes`. Extension can be gradual.
