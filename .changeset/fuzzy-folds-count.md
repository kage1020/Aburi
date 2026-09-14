---
"@aburi/markdown-projection": patch
---

A folded summary counts the entries it folds, not the lines it renders

The Dropped changes fold prefixes each direction group with a heading and separates the groups
with a blank line, and those rows were counted as entries. Moved and Syntax-only render one row
per entry, so their output does not change.
