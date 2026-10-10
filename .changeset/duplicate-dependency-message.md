---
"@aburi/diff": patch
---

The errors `buildDiff` and `computeSlices` raise for a document that repeats a Symbol, Component or Dependency, or for a malformed Slice record, no longer cite design-doc sections; each says on its own why the input is refused.
