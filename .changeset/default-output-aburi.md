---
"@aburi/cli": minor
"@aburi/github-action": minor
"@aburi/config": patch
"@aburi/types": patch
---

Write to `.aburi/` by default instead of `out/`

With neither `--output-dir` nor `output.dir` in the config, `aburi scan`, `aburi diff` and `aburi explain` now write their artefacts to `.aburi/`, and that is where `aburi explain` looks for an IR. `out/` is where tsc, Next.js, Electron Forge and VS Code extensions put build output, so Aburi's files landed beside theirs and went with a `clean` step.

When a run creates `.aburi/` under the working directory, it writes a `.gitignore` of `*` into it, so the first scan in a repository leaves `git status` clean with nothing added to your own `.gitignore`. What decides is the place, not the spelling: `--output-dir .aburi` and `output.dir: ".aburi"` get the same file. A `.aburi/` that was already there is left as it is, as is any other output directory, which may be one you commit.

The GitHub Action's `output-dir` input now defaults to `.aburi` too, and the config schema's `output.dir` default reads `".aburi"`.

To keep the old place, set `"output": { "dir": "out" }` in `aburi.json`, and `output-dir: out` on the action. A workflow that reads `out/diff.md` or uploads `out/` as an artifact has to read `.aburi/` instead, and `actions/upload-artifact` needs `include-hidden-files: true` to upload a dot-directory.
