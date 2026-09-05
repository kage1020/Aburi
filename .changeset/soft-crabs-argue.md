---
"@aburi/github-action": patch
---

Keep a failing step from taking the gate's verdict down with it

Three ways the action could fail while saying something other than what happened.

**A warning could be read as a path.** The workspace resolver's stderr was merged into the captured
stdout, so anything Node wrote there while still exiting 0 — an `ExperimentalWarning` from the
caller's `NODE_OPTIONS`, a corepack notice — was prepended to the path and then run as one. The
result was `Cannot find module '(node:1234) ExperimentalWarning: …'`: exit 1, reported as the
CLI's runtime error, pointing the reader at the code being analysed. stderr goes to a file now, and
is quoted back only when the resolve actually failed.

**A misconfiguration could read as success.** The resolver's failure exits before the step writes
its outputs, so `cli-exit-code` came back empty rather than `2`. A caller testing
`cli-exit-code != '0'` passed on the empty string; one writing `cli-exit-code || '0'` read the
failure as clean. The outputs are written before that exit now, and the output's own description
says which value means what.

**A tripped gate could vanish behind an API error.** The step that propagates the CLI's exit code
had no `if: always()`, and a composite action stops at its first failing step — so a 403 or a rate
limit while posting the comment ended the job on a GitHub API failure, with `--fail-on` having
fired and nothing in the log saying so. It runs unconditionally now; an empty exit code, from an
earlier step failing on its own terms, reads as 0 and leaves that failure standing.
