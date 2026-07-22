---
"@aburi/framework-express": minor
"@aburi/lang-typescript": minor
"@aburi/types": minor
"@aburi/core": patch
---

Add `@aburi/framework-express`, a new framework plugin that classifies Express
sources into five `framework:express:*` extKinds so Router-based apps and
plain `app.get(...)` registrations can be scanned by Aburi.

Recognised shapes (first-match-wins in the order listed):

- `framework:express:router` — `const r = Router()` / `const r = express.Router()`
- `framework:express:route` — `receiver.<method>(path, handler)` where `<method>`
  is one of `get` / `post` / `put` / `patch` / `delete` / `all`
- `framework:express:middleware` — `.use(...)` with an arity-3 inline handler
  (or an identifier reference — flagged with `medium` confidence)
- `framework:express:error-middleware` — `.use(...)` with an arity-4 handler
- `framework:express:mount` — `.use(pathLiteral, identifier)` two-arg shape

Confidence is `high` when the file imports `express` (ESM or CommonJS
`require('express')`) and `medium` otherwise — the classification survives so
the workspace projection still surfaces the shape, but consumers can treat
medium-confidence rows as candidates for review.

`@aburi/lang-typescript`: extends `extractSymbols` to promote module-level
member-call expression statements (`app.get('/x', handler)`) into a new
`kind: "call"` `SymbolCandidate` when the leaf method is in a small
framework-registration whitelist. Symbol.id qnames are position-independent
(`receiver__method[__pathSlug]__d<N>`) so IR fingerprints stay stable when
leading imports or comments shift the source lines below.

`@aburi/types`: adds `"call"` to the `SymbolKind` union and an optional
`confidence?` field on `SymbolClassification` so framework plugins can express
"matches the shape but I can't fully anchor it" (Express `.use(logger)` is
`medium` unless the file imports `express`). Both fields are additive and
optional — existing plugins (react / next / nestjs) remain unaffected.

`@aburi/core`: the scan pipeline now threads `SymbolClassification.confidence`
through to `Symbol.confidence`. When no framework classifier matches, or the
winning classifier omits confidence, the value collapses to `"high"` at the
`mergeFrameworkClassification` boundary so downstream code always sees a
single, concrete `Confidence` encoding.
