---
"@aburi/core": patch
---

Scans now read source with CRLF and lone-CR line endings converted to LF, so the same file gives the same IR whatever checkout it came from. A line break inside a multi-line template literal used to reach the `syntax` fingerprint as `\r\n` on a CRLF checkout (Git for Windows' default `core.autocrlf=true`, or a commit that only converts line endings), so `aburi diff` reported the Symbol as changed and tripped `--fail-on changed`; fields copied from source text, such as a guard's `condition` and a decorator's `raw`, kept the `\r` too. A file that breaks lines with CR alone no longer reads as a single line. Line numbers and columns are unchanged.
