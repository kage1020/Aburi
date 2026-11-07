---
"@aburi/types": minor
"@aburi/plugin-registry": minor
"@aburi/core": minor
"@aburi/lang-typescript": minor
"@aburi/diff": patch
---

A language plugin's `LanguageId` is now its manifest's `languageId`, not a field of the plugin object: `LanguagePlugin.languageId` is removed, and `LangManifest` carries `languageId`. The plugin manifest schema adds it as an optional field that only a `lang` manifest may hold, and `VocabRegistry.register` requires it of every `lang` manifest. The registry refuses a token outside `[a-z][a-z0-9]*`, the reserved `slice`, and a token another registered plugin already declared (`duplicate-id`, naming both). The core refuses a Symbol id whose prefix is not the minting plugin's `languageId` (`scan-plugin-misconfigured`). `LANGUAGE_ID_PATTERN` and `RESERVED_LANGUAGE_IDS` move to `@aburi/types`, and `@aburi/core` no longer exports `RESERVED_LANGUAGE_IDS`.
