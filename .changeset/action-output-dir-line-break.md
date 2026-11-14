---
"@aburi/github-action": patch
---

Refuse an `output-dir` that holds a line break with exit 2, before `aburi diff` runs, as the other inputs are refused. Each line the action writes to `$GITHUB_OUTPUT` is an output of its own, so such a path could set another one; the step that names the reports also publishes no path whose resolved directory holds one.
