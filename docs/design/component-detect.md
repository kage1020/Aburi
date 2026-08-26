# Component Autodetect

The algorithm by which `aburi init` and `aburi scan` (when no config is present) infer logical Components from the physical structure of a monorepo.
If the config explicitly declares `components[]`, it takes precedence over the autodetect result ([`config.md`](./config.md) §6.1).

References:
- [`ir-schema.md`](./ir-schema.md) §4 — Component structure
- [`config.md`](./config.md) §6 / §12 — Component override / autodetect overview

---

## 1. Purpose

Aburi infers "which set of files forms one logical unit (Component)" with zero user input.

This enables:
- `aburi init` to generate `aburi.json` with pre-populated `components[]`
- `aburi scan` to work even without `aburi.json`
- Newcomers to get an overview of the workspace structure before writing any config

## 2. Two-stage algorithm

```
1. Workspace root detection
   - Walk upward from the CLI execution cwd
   - Take the outermost workspace marker as root

2. Component extraction
   - Run each detector in parallel from the root
   - Merge and dedupe detection results
   - Fill in id / name / languages / frameworks / publicApi / description via inference rules
```

### 2.1 Workspace root detection

Walk from cwd toward parents; the workspace root is the **outermost (closest to the filesystem root)** directory in which any of the following is found:

- `.git/` directory
- `pnpm-workspace.yaml`
- `turbo.json`
- `nx.json`
- `lerna.json`
- `go.work`
- `Cargo.toml` (containing a `[workspace]` section)
- `pyproject.toml` (containing `[tool.uv.workspace]` / `[tool.hatch.workspaces]` / `[tool.poetry]`)
- `package.json` (containing a `workspaces` field)
- `.aburi-workspace` (reserved for future use, Aburi-specific marker)

If markers are found at multiple levels, the outer one wins (e.g., the parent holding `.git` is the true root of the monorepo).

### 2.2 Component extraction

Each detector receives the workspace root and determines whether a marker it can handle exists. If so, it returns zero or more "workspace candidates".

```
detector.detect(workspaceRoot) → {
  manager: WorkspaceManager  // tool name + roots
  workspaces: Workspace[]
} | null
```

All detector results are merged, duplicates with the same path are removed, and each workspace is then converted into a Component.

## 3. Detectors

### 3.1 JS/TS ecosystem

| Detector | Marker | Workspace extraction method |
|---|---|---|
| pnpm | `pnpm-workspace.yaml` | Resolve the globs in the `packages:` field |
| npm/yarn | `workspaces` in `package.json` | Resolve globs from the array or `{packages: [...]}` |
| bun | Same as above (npm-compatible) | Same as above |
| turbo | `turbo.json` | Treated as a monorepo hint. Actual workspaces come from pnpm/npm detectors |
| nx | `nx.json` + `project.json` | Every directory containing a `project.json` |

#### 3.1.1 Glob resolution conventions

- POSIX globs (forward slashes)
- Relative to the workspace root
- **A pattern names a directory that holds the manifest, and is resolved against the manifest**: `p` is matched as `p/package.json` (a trailing slash replaced), and the directory holding each match is the candidate. This is how pnpm and npm resolve these patterns, and it is the same rule the nx detector follows with `project.json`. Three consequences worth stating:
  - `.` and `./` name the workspace root itself, and nothing else. Matched as a directory instead, `.` is a pattern that reaches every directory in the workspace.
  - A literal path names that directory, not its subtree.
  - A matched directory with no manifest is not a package, and is not a candidate.
- A negated pattern (`!packages/legacy`) takes the same transform and removes the package it names
- An empty pattern declares nothing
- **`package.json` is the only manifest recognized.** pnpm also accepts `package.yaml` and `package.json5`, and globs `package.{json,yaml,json5}`; a package declared in either is not detected here, because the manifest is parsed as JSON for the id, name, frameworks and public API. Supporting them is a parser change, not a resolution one.
- **Which resolved directories become Components is §5's rule, not the manager's.** pnpm counts the workspace root as a workspace project unconditionally — *"The root package is always included, even when custom location wildcards are used"* — and a pattern naming it changes nothing for pnpm. Here it does: the root is a Component when a pattern names it, and otherwise only through §5's no-detector fallback. A root Component's `roots: ["."]` contains every other component's root, so making one unconditionally would give every workspace a component whose census covers the whole tree.
- Maximum depth of `**` is 10 (to avoid false positives)
- A path matching multiple globs counts as a single entry
- Anything under `node_modules/` is always excluded

### 3.2 Go ecosystem

| Detector | Marker | Workspace extraction method |
|---|---|---|
| go | `go.work` | Enumerate the directories in `use ./module-a` |

If there is no `go.work` but a standalone `go.mod`, the root is a single module = a single Component.

### 3.3 Rust ecosystem

| Detector | Marker | Workspace extraction method |
|---|---|---|
| cargo | `Cargo.toml` with `[workspace]` | Resolve the globs in `members = [...]` |

If there is a standalone `Cargo.toml` without `[workspace]`, the root is a single crate = a single Component.

### 3.4 Python ecosystem

| Detector | Marker | Workspace extraction method |
|---|---|---|
| uv | `pyproject.toml` with `[tool.uv.workspace]` | `members = [...]` |
| hatch | `pyproject.toml` with `[tool.hatch.workspaces]` | members |
| poetry (multi-project) | Search for multiple `pyproject.toml` files with `[tool.poetry.dependencies]` | Recursive detection of subdirectories |

Python workspace standards are fragmented, so multiple detectors exist.

### 3.5 Others (planned)

| Manager | Marker | Notes |
|---|---|---|
| Lerna | `lerna.json` | Overlaps with npm/yarn detection |
| Bazel | `WORKSPACE` / `WORKSPACE.bazel` / `MODULE.bazel` | Extract workspaces from BUILD files |
| Maven | `pom.xml` with `<modules>` | Parent project + modules |
| Gradle | `settings.gradle(.kts)` with `include(...)` | Included projects |
| Elixir | `mix.exs` umbrella project | Everything under `apps_path` |
| Composer | `composer.json` (when using composer/installers) | Not generalized; deferred |

Currently only JS/TS detectors are implemented. For the others, the detector plugin interface is defined so that each language plugin can add detectors in a future release (§7; see the [roadmap](../roadmap.md)).

## 4. Inference of Component fields

Mapping from each workspace to a Component.

### 4.1 `id`

Priority order:
1. `package.json#name` (JS/TS): strip the scope and kebab-case it (`@scope/billing` → `billing`)
2. `project.json#name` (nx): the project name, for a directory that has no `package.json`
3. `package.name` in `Cargo.toml` (Rust)
4. `project.name` in `pyproject.toml` (Python)
5. Trailing segment of the module name in `go.mod` (Go)
6. Kebab-case the trailing segment of the workspace directory's full path

This is a priority over **sources**, not a single source: neither a manifest that carries no `name` nor one whose `name` yields no id is an answer, and the next source is asked before the directory name is. `@scope/` is a name §4.2 can use and §4.1 cannot, so a Component can take its `id` and its `name` from different manifests.

A directory that several detectors claim is described by all of their manifests at once (§7), and they are read in this order — by filename, so the order the detectors happened to run in cannot move an id. The `package.json` under a candidate's root is read whether or not a detector reported it: a directory holding one is an npm package however it was found, and nx reports only `project.json`.

On collision (multiple workspaces yielding the same id) → append the parent directory name as a suffix (`billing` → `billing-apps` / `billing-packages`). When the parent segment kebab-cases to nothing, the id is left unsuffixed and the numeric-suffix pass (`billing-2`, `billing-3`) resolves the collision instead.

The result must satisfy `aburi.ir.v1.json#/$defs/ComponentId`. Names that kebab-case to the empty string — a directory whose name is entirely non-ASCII, say — cannot yield an id, and detection aborts with `invalid-component-id` naming the manifest or directory it came from. Declare the component explicitly in `aburi.json` `components[]` to override the derivation.

### 4.2 `name`

Priority order:
1. Full name from `package.json#name` (including the scope, e.g. `@scope/billing`)
2. The `name` field of other manifests, in §4.1's order
3. The trailing segment of the workspace directory as-is (capitalized)

### 4.3 `roots`

A single element: the detected workspace path.
POSIX path relative to the workspace root.

### 4.4 `languages`

Shallow-scan each component's subtree (up to 3 directory levels below its own root) and tally extension frequencies, over the files the workspace has not excluded — see §8. Include the language id for each extension exceeding the threshold (>5% and >10 files).

The census counts every extension in the table below, whether or not a lang plugin claims it. That is deliberate and is the point of the paragraph after next: the field answers "what is this component written in", not "what did this run parse", and `aburi init` has to answer it before any plugin is resolved. A file too large for `maxFileSizeBytes` counts for the same reason.

**Minority-language files below the threshold** are handled as follows:

- Not included in `Component.languages[]` (autodetect lists primary languages only)
- However, if the corresponding lang plugin is enabled, those files are still scanned normally and Symbols are extracted
- "Symbols in a language not listed in `Component.languages`" is normal (e.g., a mostly-TS component containing a few `.py` scripts with the py plugin enabled)
- Files in a language with no corresponding lang plugin are skipped with a warning (same handling as §6.5)

The role of `Component.languages[]` is to indicate "the primary languages needed to understand this component". It is independent of the Symbol extraction scope.

Extension mapping:

| Extension | language id |
|---|---|
| `.ts`/`.mts`/`.cts` | `ts` |
| `.tsx` | `tsx` |
| `.js`/`.mjs`/`.cjs` | `js` |
| `.jsx` | `jsx` |
| `.py` | `py` |
| `.go` | `go` |
| `.rs` | `rs` |
| `.java` | `java` |
| `.kt`/`.kts` | `kt` |
| `.scala` | `scala` |
| `.rb` | `rb` |
| `.php` | `php` |
| `.cs` | `cs` |
| `.swift` | `swift` |
| `.ex`/`.exs` | `ex` |

This mapping is not fixed: it can be reverse-derived from the `fileExtensions` each language plugin declares ([`lang-plugin.md`](./lang-plugin.md) §4.1).

### 4.5 `frameworks`

Detect known frameworks from dependency manifests:

| Source | Detection pattern → framework id |
|---|---|
| `package.json` deps/devDeps | `@nestjs/core` → `nestjs` |
| Same as above | `next` → `nextjs` |
| Same as above | `react` (with react-dom) → `react` |
| Same as above | `vue` → `vue` |
| Same as above | `express` → `express` |
| Same as above | `fastify` → `fastify` |
| Same as above | `koa` → `koa` |
| Same as above | `hono` → `hono` |
| Same as above | `astro` → `astro` |
| Same as above | `svelte` (kit/dev) → `svelte` |
| Same as above | `solid-js` → `solid` |
| Same as above | `@trpc/server` → `trpc` |
| `go.mod` | `github.com/gin-gonic/gin` → `gin` |
| Same as above | `github.com/labstack/echo` → `echo` |
| Same as above | `github.com/gofiber/fiber` → `fiber` |
| `pyproject.toml` deps | `django` → `django` |
| Same as above | `fastapi` → `fastapi` |
| Same as above | `flask` → `flask` |

The list is owned by the Aburi core, but a mechanism is planned whereby a framework plugin, once it declares its name in `manifest.provides.frameworks[]`, can extend the "detection pattern → name" mapping on the plugin side (see the [roadmap](../roadmap.md)). Today the fixed core list is used.

Detected frameworks are **only recorded in `Component.frameworks[]`**; the corresponding plugin is not auto-enabled ([`config.md`](./config.md) §15.1).

### 4.6 `publicApi`

Resolve `exports` / `main` / `module` / `types` from `package.json`:

```jsonc
// package.json
{
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client.ts"
  }
}
```

→

```jsonc
{
  "publicApi": ["src/index.ts", "src/client.ts"]
}
```

If there is no `exports`, take the file path from `main` / `module` / `types`.
If none exist, the `publicApi` key is **omitted** — it is Class B under [`ir-schema.md`](./ir-schema.md) §1.1, so "no public surface declared" is spelled as an absent key, never as `[]`. `frameworks` follows the same rule; `description` is Class A and is written as an explicit `null` when detection has nothing to put there.

For Python / Go / Rust, each language plugin will provide "public API file" inference logic in a future release (see the [roadmap](../roadmap.md)). Today only JS/TS is covered.

## 5. Single project (non-monorepo)

If no detector hits, the workspace root is treated as **a single Component**:

```jsonc
{
  "id": "<inferred from package.json name>",   // or the workspace root's directory name
  "name": "<same as above>",
  "roots": ["."]
}
```

This lets Aburi work even for the smallest single-project setups (e.g., a standalone TypeScript repository).

**"No detector hits" means no candidate directory, not no marker.** A manifest that parsed and declared no package reaches the same fallback, and there are two ways to get there:

- A `pnpm-workspace.yaml` with no `packages:` field. pnpm reads that the same way — *"If the `packages` field is omitted, only the root package is included in the workspace"* — so the whole repository as one Component is the right answer.
- Patterns that matched nothing: a mistyped pattern, a monorepo with no packages in it yet, or packages whose manifest is one §3.1.1 does not recognize. The whole repository becomes one Component and nothing says why, which is the wrong answer arrived at silently. Detection has no diagnostic channel to say it on today.

## 6. Detector extension mechanism

Language plugins can provide additional detectors:

```ts
interface ComponentDetector {
  id: string                                 // "uv", "cargo", "go-work", etc.
  detect(workspaceRoot: string): DetectorResult | null
}

interface DetectorResult {
  manager: WorkspaceManager                  // an element of workspace.managers[] per ir-schema §2
  workspaces: WorkspaceCandidate[]
}

interface WorkspaceCandidate {
  root: string                               // path relative to workspace root
  manifestPath: string                       // path to package.json, etc.
  rawMetadata: unknown                       // raw parse result of the manifest (aids Component inference)
}
```

Allowing each language plugin's `manifest.provides` to include a detector is a planned extension (see the [roadmap](../roadmap.md)); today the fixed core detector set is used.

## 6.5 Handling mixed languages/runtimes

A monorepo mixing multiple managers, such as `apps/web` (pnpm) + `apps/api` (cargo) + `services/ml` (uv), lets each detector hit independently.

- Record all detected tools in `workspace.managers[]` (e.g. `[{tool:"pnpm",...}, {tool:"cargo",...}, {tool:"uv",...}]`)
- Each workspace becomes a Component under its own manager's naming conventions
- Each Component's `languages` is determined automatically by scanning its subtree (§4.4)
- Since **only TS is supported today**, when a non-TS workspace is detected:
  - The Component is still created (to preserve the full architectural picture)
  - The language is included in `languages`, but Symbol extraction is skipped
  - Recorded in `stats.skippedFiles[]` with `reason: "unroutable"` — that reason covers both ways a file has no route into the Document, and here it is the first: no loaded plugin claims the extension (to be revisited when more languages land — see the [roadmap](../roadmap.md))
  - Warning on stderr: `Component <id> has language <lang> but no lang plugin enabled. Symbols not extracted.`

## 7. Conflict resolution

When multiple detectors return the same path (e.g., both pnpm and turbo detect `packages/billing`):

- **Merge into one** workspace candidate (dedupe by path)
- Record `manager` information from both (two entries in `workspace.managers[]`)
- A single Component
- Keep **every** manifest the detectors found for that directory, plus the `package.json` under its root whether or not one of them reported it, and read them in §4.1's order for `id` and `name`. A directory claimed by pnpm and nx at once has a `package.json` and a `project.json`, and they routinely name it differently: the first is the published npm name the rest of the Document is written against, the second an nx project name
- A manifest that is present and cannot be read — bad JSON, or an IO failure that is not "no such file" — aborts detection with `workspace-manifest-malformed` naming the file. Absent is the ordinary case and says nothing; unreadable is an identity this run cannot see, and answering with the next manifest's name would hide it
- `frameworks` (§4.5) and `publicApi` (§4.6) are read from the `package.json` alone. They are defined over `dependencies` and `exports`, which are npm's fields; an nx `project.json` holds targets whose options are arbitrary JSON, so a key of either name in one is not the npm field it resembles

When multiple detectors generate the same id with different paths (§4.1):
- Append suffixes per the collision-avoidance convention in §4.1

## 8. `.gitignore` / exclusions

- Honour `.gitignore` per `config.respectGitignore`, by the rules in [`drop-list.md` §3.3](./drop-list.md) — every directory's file, asked about each candidate rather than folded into the traversal's exclusion globs
- Category A's core patterns apply too, the same list discovery uses rather than a copy of part of it: `node_modules/`, `vendor/`, `__pycache__/`, `out/`, `.venv/`, `*.d.ts` and the rest of [`drop-list.md` §3.1](./drop-list.md)
- `config.ignore[]` and the loaded language plugins' file-drop globs apply when the caller has them. The census is one walk from the **workspace root**, bucketed by component root afterwards, because those patterns are workspace-root relative by contract and cannot be matched against a walk rooted inside a package
- The one caller that has neither is `aburi init`, which detects components in order to write the first config. It honours `.gitignore` and the core patterns, which is everything knowable before a config exists
- The contents of `.git/` are never read, but its presence is used as a workspace root marker

## 9. Performance

The autodetect portion of `aburi init` / `aburi scan` targets **<200ms (medium-sized monorepo)**.

Implementation guidance:
- Filesystem traversal is asynchronous and parallel
- Manifest reads are memoized
- Glob resolution uses an efficient fast-glob-style implementation

## 10. Verifiable properties

| ID | Input | Expected |
|---|---|---|
| CD1 | `pnpm-workspace.yaml: packages: ["packages/*"]` + `packages/{a,b,c}/package.json` | 3 Components detected, ids from each package.json#name |
| CD2 | npm workspaces `["apps/*", "libs/*"]` | Every package under apps and libs becomes a Component |
| CD3 | turbo.json + pnpm-workspace.yaml | Same workspace as 1 Component, 2 entries in managers[] |
| CD4 | `Cargo.toml` `[workspace] members = ["crate-a"]` | 1 Component (crate-a) |
| CD5 | `go.work` `use ./mod-a ./mod-b` | 2 Components |
| CD6 | Single TS project with no markers | 1 Component (root, id = package.json name) |
| CD7 | `package.json#name = "@scope/billing"` | Component.id = "billing", Component.name = "@scope/billing" |
| CD8 | 2 workspaces generate the same id (both "shared") | Suffixes appended ("shared-apps" / "shared-packages") |
| CD9 | `dependencies: {"@nestjs/core": "..."}` | frameworks = ["nestjs"] |
| CD10 | `package.json#exports: {".": "./src/index.ts"}` | publicApi = ["src/index.ts"] |
| CD11 | Autodetect finds nothing and there is no package.json | id = directory name (kebab-case), name = directory name |
| CD12 | config.components overrides after autodetect | config wins ([`config.md`](./config.md) §6.1) |
| CD13 | Both pnpm and nx detect the same workspace | Deduped into 1 Component |
| CD14 | `packages: [".", "packages/*"]` on a tree that also holds `src/` and `a/b/c/d/` | 2 Components: the workspace root (`roots: ["."]`) and the package |
| CD15 | `packages: ["packages/*"]` where `packages/dist/` holds no manifest | `packages/dist` is not a Component |
| CD16 | `packages: ["packages/*"]` where *no* matched directory holds a manifest | `managers[]` records pnpm with `roots: []`, and §5's fallback makes the whole repository one Component |
| CD17 | pnpm and nx both claim `apps/billing`; `package.json#name = "@acme/billing-api"`, `project.json#name = "billing-e2e"` | 1 Component, id `billing-api`, name `@acme/billing-api`, with the `package.json`'s frameworks and publicApi |
| CD18 | nx alone claims `apps/billing`, `project.json#name = "billing-web"` and a `dependencies` key in it | id and name `billing-web`, no frameworks, no publicApi |
| CD19 | nx alone claims `apps/billing`, and a `package.json` sits beside the `project.json` | Identity, frameworks and publicApi come from the `package.json` |
| CD20 | `apps/billing/package.json` is not valid JSON | Detection aborts with `workspace-manifest-malformed` naming the file |

## 11. Design decisions

### 11.1 Why the workspace root is the outermost marker

When markers are found at multiple levels (e.g., a sub-project inside a monorepo also has a `package.json`), taking the inner one as root would miss the structure of the entire monorepo. Taking the outermost as root avoids unintended subset detection.

### 11.2 Why framework plugins are not auto-enabled

Same reasoning as [`config.md`](./config.md) §15.1: rogue dependencies, unpredictable behavior, hard to trace. Detected framework names are only recorded on the Component; plugin enablement is a user decision (`aburi init` merely suggests candidates on the console).

### 11.3 Why package.json name takes top priority for id inference

The package.json name in a monorepo is an identifier deliberately chosen by a human. Directory names change easily (e.g., renaming apps → workspaces during refactoring). Prioritizing the package.json name makes Component ids resilient to path changes.

### 11.4 Why a single project always yields exactly 1 Component

Allowing a "zero Components" state breaks the structure of the whole IR (Symbols would have `component: null`). Guaranteeing at least one Component simplifies Markdown projection / diff.

### 11.5 Why per-language detectors are deferred

Only TS is supported today. Building multi-language detectors when no plugin other than lang-typescript exists would leave them unused. Providing the corresponding detector at the same time each language plugin is added keeps responsibilities clear.

### 11.6 Limits of publicApi auto-inference

The public API expressed by `package.json#exports` is file-granular; it cannot express fine-grained symbol-level selection (Aburi's `publicApi[]` accepts globs or symbol ids).
Autodetect currently stops at file glob output; if symbol-level filtering is needed, users specify it manually in the config.

In the future, cross-referencing each language plugin's `extractSymbols` results with `package.json#exports` leaves room to extend to symbol-level output such as `publicApi: ["ts:src/index.ts#Invoice", "ts:src/index.ts#createInvoice"]`.
