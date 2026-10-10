---
"@aburi/markdown-projection": minor
---

Removes `inlineCodePath` and `inlineCodeValue`, the deprecated aliases of `inlineCode`; call `inlineCode` instead.

The Slice View note about unresolved calls and two refusal messages no longer cite design-doc sections. A Slice with no members is now refused instead of being left out of the Slice View without a word, and both of the Slice View's refusals throw `ProjectionInvariantError`, naming the field and the Slice, like the projection's other invariant violations.
