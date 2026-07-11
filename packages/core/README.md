# @aburi/core

Language-agnostic foundation for every downstream Aburi package:

- **Symbol id generation** — deterministic `<language>:<posix-path>#<qname>`.
- **Canonical JSON serializer** — NFC normalisation + codepoint-sorted keys, so
  same IR → same bytes across OSes and Node versions.
- **11 IR invariants** (`assertIRIntegrity`) — the contract every scan / diff
  output must satisfy before it hits disk.
- **Autodetect** — workspace root (marker files), package manager
  (`pnpm-lock.yaml` / `bun.lockb` / …), and JS/TS Components (package.json
  `name` / `exports` / framework-driven dependency inference).
- **Scan orchestration** — discover → route → parse → classify → walk-body →
  drop → fingerprint → integrity check. Handles per-call timeouts, drop
  categories A / B / C, and IR assembly with schema-conformant ordering.

The scanner drives every registered `LanguagePlugin` / `FrameworkPlugin` /
`EffectPlugin` through a single deterministic pipeline; ordering / integrity is
enforced here so plugins do not have to.

## Install

```bash
pnpm add @aburi/core
```

## Usage

```ts
import { scan, writeCanonicalIR, assertIRIntegrity, detectWorkspaceRoot } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { VocabRegistry } from "@aburi/plugin-registry"

const registry = new VocabRegistry()
registry.register(langTypescriptPlugin.manifest)
registry.register(nestjsFrameworkPlugin.manifest)

const result = await scan({
  workspaceRoot: await detectWorkspaceRoot({ cwd: process.cwd() }),
  config: {},
  languages: [langTypescriptPlugin],
  frameworks: [nestjsFrameworkPlugin],
  effects: [],
  registry,
})
// result.ir passes assertIRIntegrity — throws before returning otherwise.
```

Canonical write:

```ts
// writeCanonicalIR(ir, outputPath, options?) creates the parent directory and
// writes the canonical bytes for you; the returned string is the serialized
// payload for callers that also want it in memory.
await writeCanonicalIR(result.ir, "out/aburi.ir.json")
// or with the compact format used by `aburi scan --compact`:
await writeCanonicalIR(result.ir, "out/aburi.ir.json", { format: "compact" })
```

## See also

- [`docs/design/ir-schema.md`](../../docs/design/ir-schema.md) — IR contract + 11 invariants.
- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the language-plugin contract the scan pipeline drives.
- [`docs/design/drop-list.md`](../../docs/design/drop-list.md) — drop rules A / B / C.
