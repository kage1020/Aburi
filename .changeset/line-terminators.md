---
"@aburi/core": patch
---

Scans now read source with CRLF and lone-CR line endings converted to LF, so a file the scan reads gives the same Symbols whatever line endings it was checked out with. A line break inside a multi-line template literal used to reach the `syntax` fingerprint as `\r\n` on a CRLF checkout (Git for Windows' default `core.autocrlf=true`, or a commit that only converts line endings), so `aburi diff` reported the Symbol as changed and tripped `--fail-on changed`; fields copied from source text, such as a guard's `condition` and a decorator's `raw`, kept the `\r` too. Line numbers and columns are unchanged on an LF or CRLF checkout; a file that breaks lines with CR alone, which used to read as a single line, now gains the lines it was written with.

An IR scanned before this release from files saved with CRLF or a lone CR, compared with one scanned after, reports each Symbol with a line break inside a template literal or a string as a syntax-only change, once; `api` and `logic` do not move. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with this release and is unaffected.
