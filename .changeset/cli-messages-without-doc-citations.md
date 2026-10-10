---
"@aburi/cli": patch
---

Warnings and refusals no longer cite design-doc files: the call-resolution warning of `aburi diff`, the two strict-vocabulary messages of `aburi scan`, and the two refusals of `aburi explain --debug-resolution`, which now say the IR does not keep the per-call buckets.
