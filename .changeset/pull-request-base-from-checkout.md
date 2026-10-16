---
"@aburi/github-action": minor
---

Breaking: a run whose checkout is neither the merge ref nor the pull request's head (a default `pull_request_target` checkout, for example) now fails with exit 2 instead of reporting a diff of the base branch. On the base branch, check out the pull request's head or merge ref; where the checkout already holds the pull request's code, set `refspec` to name both sides yourself.

With no `refspec`, a pull request is now compared against the tree its checkout grew from. The merge commit a plain `actions/checkout` gives a `pull_request` run is compared with its first parent, the base branch commit it was merged into, and a merge whose first parent is not on `origin/<base.ref>` is refused. A checkout of the pull request's head is compared with its merge base with the base branch: `origin/<base.ref>` as the clone fetched it, and `pull_request.base.sha`. Without that tracking ref the head is compared with its merge base with `base.sha` alone, and a warning says so. A pull request that has fallen behind its base branch is no longer charged with the base branch's newer changes, and both sides are the full SHAs of the trees compared.

A shallow clone, which `aburi diff` refuses anyway, now stops before the diff with exit 2 and a message that names what is checked out before saying the clone is shallow. An explicit `refspec` is trimmed and used as given, and one that spans more than one line is refused. `cli-exit-code` is set whenever the run fails, even before the diff: 2 for a rejected input or ref spec, 1 for a failed setup step. The step that resolves the ref spec now runs from `working-directory`, after the Node and pnpm setup.
