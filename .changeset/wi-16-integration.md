---
"@aburi/core": patch
---

Add `fixtures/nestjs-billing/` + `packages/e2e-integration` — the end-to-end suite
demanded by WI-16.

### Fixture

`fixtures/nestjs-billing/` is a handwritten NestJS-shaped billing service (10 `.ts`
files under `src/`, two modules × controller × service, one DTO, a shared logger).
Structured to exercise every axis the diff engine care about: 6 boundary-decorated
route handlers, 3 `@Injectable()` providers with real method bodies, module classes,
and a service (`BillingService`) with 12 non-boundary methods that scenario B mutates
into empty bodies. TS type correctness is deliberately loose in the mutations —
Aburi parses via tree-sitter and never invokes tsc, so `void`-return bodies on
methods declared to return an object are fine as scanner input.

### Test package

`packages/e2e-integration` is a private test package. It drives `runInit` from the
CLI directly (autodetect exercises no plugin resolution), then drives the scan +
diff paths via `@aburi/core` `scan` + `@aburi/diff` `buildDiff` with workspace
plugins imported as ES modules — bypassing `runScan`'s `pnpm dlx` plugin
resolution because the fixture is copied to a bare tmpdir without `node_modules`.
Plugin-name resolution is already covered by `packages/cli/test/plugin-loader.test.ts`,
so this suite focuses on integration correctness of the scan → diff pipeline
end-to-end.

Snapshots are structural (component/route counts, per-status distribution, gate
outcome) rather than byte-exact — a full IR snapshot would rot on every plugin
tweak.

### Scenarios

- **Init** (4 tests): autodetect lands on 1 component with `ts` + `nestjs`, writes
  `aburi.json` with the schema URL, refuses to overwrite without `--force`, honours
  `--force`.
- **Scan** (5 tests): every source file is discovered (no discovery-time skips),
  IR integrity passes, controllers land under `framework:nestjs:controller` with
  boundary routes, services under `framework:nestjs:provider` with all methods
  kept, modules under `framework:nestjs:module`.
- **Diff scenario A** — a single `throw` added to `BillingService.applyRefund`.
  Two `changed` Symbols surface (the method itself and the enclosing class whose
  fingerprint mixes member ASTs), `--fail-on changed` trips.
- **Diff scenario B** — every `BillingService` method body reduced to `{}`. Eleven+
  `dropped-toggled:to-dropped` changes fire (`empty body` drop hint per
  `lang-typescript` drop-hints), `--fail-on dropped-toggled:to-dropped:>10` trips.
  The plan's AC quoted "exit 1", which pre-dates the WI-14 exit-code table; the
  test asserts against the settled contract (`EXIT.GATE = 3`).
- **Diff scenario C** — `common/logger.service.ts` moves under `common/logging/`
  with importer paths updated. Stage-3 logic-fingerprint matching pairs the moved
  Symbols: `moved > 0`, `added/removed/droppedToggled = 0`, and
  `--fail-on removed,dropped-toggled` does NOT trip.

### `@aburi/core` bug fix (patch)

WI-16 uncovered a real integrity violation in `buildKeptSymbol`
(`packages/core/src/scan/pipeline.ts`): `rules[]` was sorted by line but `calls[]`
was written back in AST-traversal order, which is not always source order. Any
Symbol with two calls that the language plugin visited out of order failed IR
invariant #11 (`calls[].line` monotonic). The fixture's BillingService methods
were the first test surface long enough to trigger the misordering; smaller unit
tests happened to pass because their bodies contained ≤ 1 call. Fixed here so
every downstream consumer can rely on the invariant without pushing the burden
onto every plugin.

### Tooling

- `biome.json` — `!fixtures` added to `files.includes`. Fixture source is
  intentionally shaped (unused decorator-consumed parameters, non-`import type`
  refs) and must not be judged against production lint rules.
