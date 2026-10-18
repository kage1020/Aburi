---
"@aburi/cli": patch
"@aburi/core": patch
---

A fault in the plugin set now exits 3 whichever error class carries it, and a refused plugin manifest names the `aburi.json` entry that loaded it.

`aburi scan`, `aburi diff` and `aburi explain` exited 3 for an undeclared value only when the core's own vocabulary check found it. A plugin that refused a value through the registry it is handed (`ctx.registry.assertEffectDeclared` or `assertExtKindDeclared`) raised the registry's error under the same `vocab-undeclared` code, and the run exited 1, the code for a failure of the machine. So did the other two faults the core lets end the run, an effect plugin returning a Promise from `classify` and a language plugin stamping Symbol ids with no valid language prefix. All three now exit 3, recognised by code as the core recognises them; the registry's refusal does so under `--discover` too, since the registry does not read `strict`. `@aburi/core` exports the predicate it uses for this, `isPluginSetFault`.

A manifest the registry refuses at load already exited 3, with the registry's message alone, which names plugins by manifest name: `extKind prefix "framework:acme" is already declared by plugin "framework-one".` It now leads with the config entry, `Plugin "./plugins/framework-two.mjs" cannot be registered: …`, which also says which plugin is meant when the registry's message names none (a manifest value JSON cannot carry) or names the colliding manifest only (two entries loading plugins under one name).

Nothing changes in an IR or a report: these runs write neither.
