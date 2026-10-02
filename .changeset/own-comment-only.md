---
"@aburi/github-action": patch
---

The comment upsert now rewrites only Aburi's own comment: one whose body opens with `<!-- aburi:diff-comment -->` and whose author is the account the token posts as (the login `GET /user` returns for a personal token, a `[bot]` account for an installation token such as the default `github.token`). It used to take the first comment that contained the marker anywhere, so a person's comment quoting it, or one a fork's author posted ahead of the `workflow_run` companion, was overwritten with the report and Aburi's own comment was left stale. `ensureMarker` and the script now put the marker first even when the report quotes it further down.
