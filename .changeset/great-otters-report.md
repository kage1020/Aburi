---
"@aburi/github-action": minor
---

Let a fork's pull request get its report, without handing the fork a writable token

A pull request from a fork runs with a read-only `GITHUB_TOKEN`, and no `permissions:` block
changes that — the event decides the scope before any step runs. Dependabot's pull requests are the
same case from the other direction: the branch lives in the repository and passes every `head.repo`
check, and the token still cannot comment. So the two kinds of pull request that most need the
report — an outside contribution, and a bump whose effect on the API nobody reads by hand — were
the two that only ever got a red or green check and an artifact nobody downloads.

`pull_request_target` is the usual answer and the wrong one here: it would give a writable token to
a job whose whole purpose is to analyse the head, which on a fork is code the contributor controls.

The work splits in two instead. The pull request's own run analyses, gates, and uploads `out/` as
an artifact; a `workflow_run` workflow in the base repository downloads that artifact and posts the
comment. `.github/workflows/aburi-comment.yml` is this repository's own half of that pair, and
`docs/design/github-action.md` §5.1 is the contract — including the three things that make the
privileged half safe: it executes nothing from the head (a sparse checkout of the default branch,
for one script), the pull request number is resolved from the event rather than read out of the
artifact (a fork can edit the analysis workflow, and so what it uploads; it cannot edit the head
repository and branch GitHub recorded for the run), and no artifact content is interpolated into a
shell.

Which half comments is decided once, in the analysis job, and travels in the artifact as a
`comment-pending` file — a second copy of that decision, written against a different event payload,
is a copy that can disagree, and the way it disagrees is that nobody comments at all. The decision
is the outcome rather than the permission: the marker is written when the run finished with no
comment of its own, which covers the upsert that was refused as well as the one that was never
allowed. The companion says out loud when it stands down, and fails rather than exiting green when
it has a report and cannot place it — a `workflow_run` workflow posts no check, so a line in a
collapsed step log is the same as saying nothing.

The upsert the action runs is now `scripts/upsert-comment.mjs` rather than an inline
`actions/github-script` block, because the companion workflow runs the same one: one marker string,
one flow, one set of tests, and no second implementation to keep in step. Behaviour is unchanged —
find the comment carrying `<!-- aburi:diff-comment -->`, rewrite it in place, report `unchanged`
when the bytes already match — and the step's `comment-id` and `comment-action` outputs still carry
the outcome. Input reaches it through the environment only, never argv: on a fork's pull request
the Markdown names symbols that pull request declares. Exit 2 says the invocation is wrong, exit 1
that the API refused, each as one `::error::` line.

The script is plain `.mjs` with no dependencies and is published with the action, so anything with
Node can post an Aburi comment: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, `MARKDOWN_PATH`,
and `GITHUB_API_URL` for Enterprise Server. `src/comment.ts` remains the library form for callers
importing the package, and a test pins the two to the same marker.
