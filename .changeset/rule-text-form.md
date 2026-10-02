---
"@aburi/core": minor
"@aburi/lang-typescript": patch
---

Rule `condition`, `what` and `expr` strings are now written in the form the IR schema gives them: comments are taken out, whitespace is collapsed to one space, and a string longer than 120 characters is cut to its first 120 plus `...`. A long guard or return no longer makes the IR fail the schema's `maxLength`, a re-wrapped guard is no longer listed under "rules modified", and a comment inside a condition or return no longer moves the `logic` fingerprint. The scan also applies the collapse and the cut at the plugin boundary, so every language plugin's rules fit the schema. `@aburi/core` exports `normalizeRuleText` and `normalizeRuleStrings` for plugins that want to write the form themselves.
