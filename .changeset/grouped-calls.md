---
"@aburi/markdown-projection": patch
---

A Symbol block's **Calls** list writes a target called from several lines on one row, ``- `logger.warn` (L12, L30, L44)``, where it wrote a row per call. `aburi explain` groups its **Calls** list the same way; its **Call resolution** table still gives each call a row.
