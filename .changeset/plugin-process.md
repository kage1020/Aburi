---
"@aburi/plugin-process": minor
---

Add `@aburi/plugin-process`, which drives a parser or classifier written in another language from a JavaScript plugin: one long-lived process per scan answering JSON-RPC requests over stdio, with a per-request timeout, a response size cap, and a fresh process for the next request after one dies.
