---
"@aburi/lang-typescript": patch
---

An escape that only a tagged template may hold, such as ``String.raw`C:\Users\u\Aburi` ``, is no longer reported as a recoverable parse error. The grammar holds every template to a string's escapes, so a Windows path under `String.raw` made the file look broken, and `aburi diff` warned on every self-diff of Aburi about a file whose Symbols were complete. The same escape in an untagged template or a string still reports, and so does a broken substitution in a tagged template, written right after such an escape or anywhere else.
