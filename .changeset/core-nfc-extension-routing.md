---
"@aburi/core": patch
---

A file whose extension is spelled in a different Unicode normalization form from the one a language plugin declares is now routed to that plugin; discovery kept such a file and the scan then dropped it as unroutable. Error messages no longer cite design-doc sections.
