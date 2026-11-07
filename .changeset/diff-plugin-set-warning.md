---
"@aburi/cli": minor
---

`aburi diff --base <ir> --head <ir>` now warns when the two IRs were made with different plugins. Each IR records `generator.plugins[]`, and the two lists were never compared, so two IRs scanned with `effects-prisma` enabled on one side only diffed as a wave of `changed` Symbols whose `db.write` effects appeared or vanished, with nothing saying why. One stderr line now names every difference, ordered by plugin name — a plugin only one side loaded, with its version and type, and one both loaded under another type, version or grammar revision:

```
⚠ The base and head IRs were made with different plugins: effects-prisma 0.6.0 (effects) only in base; lang-typescript version 0.6.0 → 0.7.0. A Symbol whose effects, kind or role a plugin decides can be reported as changed for that alone. Rescan both sides with one plugin set, or diff the two revisions (`aburi diff <base>..<head>`), which scans both with the head's plugins.
```

The line is a warning: the exit code and `diff.json` are those of the same run without it. `aburi diff <base>..<head>` never prints it, since both scans load the head's plugins.
