---
"@aburi/cli": minor
---

Let the config decide `respectGitignore` when neither flag was typed

`--no-respect-gitignore` is specified as an override — `cli-spec.md` §5.2 has always called it
"equivalent to `config.respectGitignore: false`" — but it was declared to commander as a lone
negatable option, which materialises `true` for every run that did not pass it. At the option
object a run that said nothing and a run that asked for `true` were the same value, so the CLI
forwarded `true` on every scan and it was written over the config.

A workspace whose config turned `.gitignore` off therefore got it back on, and only through the
CLI. `runScan` called directly read the config, and so did the rescan `aburi diff` performs —
which never forwarded the field at all — so one workspace produced two file sets depending on
whether the caller went through argv.

The option is now declared as a pair, `--respect-gitignore` / `--no-respect-gitignore`, the
same shape `--lsp` / `--no-lsp` already has in the same command. commander then leaves the
value absent until one of them is typed, which is what the forwarding already assumed. The
positive spelling is new: a config saying `respectGitignore: false` previously had no
command-line answer at all.
