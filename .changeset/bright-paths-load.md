---
"@aburi/cli": patch
---

Load absolute plugin paths as file URLs on every platform, including Windows paths with
forward or backslashes. Preserve spaces, `#`, and `%` in plugin filenames instead of
interpreting them as URL syntax.
