---
"@aburi/markdown-projection": minor
---

`diff.md` leaves the `<sub>api=… logic=… syntax=…</sub>` line out of Added, Removed and Unknown entries, which have one side and so nothing to compare the hashes with; the component pages keep it. `renderSymbolBlock` takes `{ fingerprint: false }` to render a block without it.
