---
"@aburi/cli": minor
---

Read `config.output.dir`, which three documents call the default for `--output-dir`

The field is in the config schema with its own `"default": "out"`, `cli-spec.md §5.2` names it
as the flag's default and `config.md §11` lists the flag as its override — and nothing in
`packages/*/src` ever read it. A workspace that set `"output": { "dir": "artifacts" }` got
`out/` on every run, silently, because writing to `out/` succeeds.

The precedence is now `--output-dir` → `config.output.dir` → `out` in `aburi scan` and
`aburi diff`, and `aburi explain` looks for the IR under the same name, so the command that
writes and the command that reads still agree on one directory.

- **The configured value resolves against the working directory**, as the flag does.
  `config.md §9` said "relative to the workspace root"; that anchor is unimplementable
  alongside the schema's `"default": "out"`, because writing the default explicitly would then
  move the artefacts in a monorepo package. The line is corrected rather than honoured — it
  described behaviour that had never run.
- **`aburi explain` and `aburi diff` now read the config where they did not.** A config that
  cannot be parsed stops them instead of being ignored: the setting is what says where the
  artefacts are, so an unread config means their location is unknown, and answering from `out/`
  would be a confident wrong answer over a swallowed error. `explain --ir <path>` and
  `diff --output-dir <dir>` are unaffected — each already answered the question the config
  would have, and neither consults it.
- The GitHub Action always forwards `--output-dir`, so `config.output.dir` does not apply
  under it. That is deliberate — the action reads `diff.md` back to post it — and is now
  stated in its README, whose row also named two files the CLI does not write.
