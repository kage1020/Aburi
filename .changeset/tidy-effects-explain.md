---
"@aburi/diff": patch
"@aburi/markdown-projection": patch
---

Report an effect as modified when its propagation flag or direct provenance changes, and render
propagated effect deltas with their direct sources when the containing Symbol is already routed to
an API or logic section. Provenance-only changes remain available in `diff.json`; fingerprint-based
Markdown section routing is unchanged.
