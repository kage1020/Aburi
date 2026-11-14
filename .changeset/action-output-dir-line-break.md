---
"@aburi/github-action": patch
---

Publish no report path from an `output-dir` holding a line break: each line the action writes to `$GITHUB_OUTPUT` is an output of its own, so such a path could set another one.
