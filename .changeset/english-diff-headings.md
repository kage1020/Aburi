---
"@aburi/markdown-projection": patch
---

Emit diff.md section headings in English only (`## ⚠ API changes`, `## 🔧 Logic
changes`, `## 💧 Dropped changes`, `## 🎨 Syntax-only changes`) and use
`N entries` in fold-out summaries. Previously these four headings mixed
Japanese words; headings are stable identifiers CI and reviewers may match on,
so this is a breaking change for anyone grepping the old strings.
