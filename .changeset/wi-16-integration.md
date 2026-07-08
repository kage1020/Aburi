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
(`packages/core/src/scan/pipeline.ts`): only `rules[]` was line-sorted before
entering the IR, while `decorators[]` / `effects[]` / `calls[]` were kept in
their producer's order. That order comes from either language-plugin AST
traversal (which is *usually* source order but not contractually guaranteed)
or `classifyCalls`'s `byTargetThenLine` (which prioritises target-alpha and
disregards line). Both violate IR invariant #11 (`decorators/rules/effects/calls[].line`
monotonic — `integrity.ts:284-311`) the moment a Symbol has two entries whose
producer-order disagrees with source order.

The BillingService methods were the first surface long enough to trigger the
`calls[]` failure; earlier unit tests happened to pass because their method
bodies had ≤ 1 call. The `effects[]` and `decorators[]` siblings shared the
same latent bug — surfaced by PR review — and would trip any Symbol that
classified two effects with target-alpha vs source-line disagreement.

Fixed in one place: `buildKeptSymbol` now stable-line-sorts all four arrays.
Same-line entries retain their producer order (schema §17 phrases the
same-line contract as "appearance order"; JavaScript's stable sort preserves
that). A caveat: for `effects[]` / `calls[]` the "producer order" is
`byTargetThenLine`'s output, so same-line entries land in target-alpha order
rather than tree-sitter emission order — the integrity check only asserts
line monotonicity, so this is a documented deviation from the strictest
reading of §17, not a runtime issue.

Guards: 4 new unit tests in `packages/core/test/scan/pipeline.test.ts` cover
calls / effects / decorators reverse-line-order inputs plus same-line stable
sort. Written against `runFilePipeline` so a regression fires here — long
before the fixture-level integration test does.

### Tooling

- `biome.json` — `!fixtures` added to `files.includes`. Fixture source is
  intentionally shaped (unused decorator-consumed parameters, non-`import type`
  refs) and must not be judged against production lint rules.
