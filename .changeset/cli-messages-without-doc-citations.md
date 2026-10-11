---
"@aburi/cli": patch
---

Warnings and refusals no longer cite design-doc files: the call-resolution warning of `aburi diff`, the two strict-vocabulary messages of `aburi scan`, and the two refusals of `aburi explain --debug-resolution`, which now say the IR does not keep the per-call buckets.

The README now says a CLI entry point should assign `process.exitCode`, as the `aburi` bin does, because `process.exit()` can truncate output still being written to a pipe.
