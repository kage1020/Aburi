# Aburi

Aburi extracts a **semantic intermediate representation (IR)** from source code so reviewers can read changes at the level of business logic, control flow, and module boundaries instead of raw diffs.

> **Status: v0.1 implementation in progress.** Detailed design (D1-D11) and v1 JSON schemas are frozen; package implementation is being delivered work item by work item per [`design/implementation-plan.md`](design/implementation-plan.md).

## Documents

- [`design.md`](design.md) — Core design philosophy and architecture overview
- [`design/roadmap.md`](design/roadmap.md) — v0.1 / v0.2 / v1.0 scope split
- [`design/implementation-plan.md`](design/implementation-plan.md) — Work item breakdown (WI-01..WI-18)
- [`design/details/`](design/details/) — D1-D11 detailed designs
- [`schema/`](schema/) — Public JSON Schemas (`aburi.ir.v1`, `aburi.config.v1`, `aburi.diff.v1`, `aburi.plugin.v1`)

## Requirements

- Node.js `>= 24`
- pnpm (managed via `packageManager` field; enable with `corepack enable pnpm`)

## Local development

```bash
pnpm install
pnpm check       # Biome lint + format check
pnpm typecheck   # TypeScript no-emit
pnpm test        # Vitest across packages
pnpm build       # tsdown across packages
```

## License

MIT
