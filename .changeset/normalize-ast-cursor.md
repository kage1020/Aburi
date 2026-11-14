---
"@aburi/lang-typescript": patch
---

Describe a declaration for its `syntax` fingerprint by walking its tree with a cursor rather than reading each node's children, which built an object for every token. The fingerprints are unchanged: the IR of each of the nine pinned benchmark repositories is byte-identical. A one-thread scan is about a tenth faster (shadcn-ui 15.4 s → 13.7 s, cal-com 20.8 s → 18.6 s), and the time spent describing declarations falls by about two fifths.
