---
"@aburi/types": minor
"@aburi/core": patch
"@aburi/diff": minor
"@aburi/markdown-projection": patch
---

`@aburi/types` exports `lastSegment`, the last segment of a qualified Symbol name that the api fingerprint hashes (`InvoiceService.createInvoice` → `createInvoice`, `C::Inner.g` → `g`). The core's `lastQnameSegment`, the diff's name matchers and the Markdown report's name-row check each carried their own copy of it; they now read this one, so the report cannot call a name change explained while the fingerprint disagrees. No fingerprint, pairing or report line moves.

`@aburi/diff` no longer exports `lastSegment`. Import it from `@aburi/types`, which answers the same for every qualified name a language plugin writes and gives `""` for an empty one, as the diff's copy did.
