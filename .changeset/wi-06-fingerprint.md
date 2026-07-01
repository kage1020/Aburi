---
"@aburi/core": minor
---

Add the fingerprint module (`@aburi/core/fingerprint`). Computes the three axes of `Symbol.fingerprint` per the design contract: `api` (declaration facets + decorators sorted by name/line + type-only signature shape, deliberately excluding `Symbol.language` and the class-scope prefix of `Symbol.name`), `logic` (rules in source order + effects by `target` only, ignoring `Effect.id` so plugin-classification churn does not perturb the hash), and `syntax` (SHA-256 over a language-plugin-supplied normalized AST string).

Every axis returns 12 lowercase hex characters (SHA-256 truncated to the first 6 bytes); every string field is NFC-normalized and whitespace-collapsed before hashing; the canonical JSON serializer from `@aburi/core` provides the deterministic byte input. Dropped Symbols short-circuit to `ZERO_FINGERPRINT` (`"000000000000"`) on every axis so cross-IR comparisons treat them as unchanged.

Public API: `apiFingerprint`, `logicFingerprint`, `syntaxFingerprint`, `computeSymbolFingerprint` (all-axes orchestrator with `dropped` short-circuit), `hashCanonicalObject`, `hashRawString`, `lastQnameSegment`, `normalizeFingerprintString`, `ZERO_FINGERPRINT`, plus `ComputeFingerprintOptions`.
