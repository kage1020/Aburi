---
"@aburi/core": minor
---

Derive a component id from the package's own name and path, not from where it sits in the list

`toIdFromNpmName` threw the npm scope away, so every `utils` in a workspace was the same id and
the collision passes had to tell them apart. In the layout nearly every monorepo has — each
package directly under `packages/` — they cannot: the parent-directory suffix is `-packages` for
all of them, and the tie-break fell through to a positional `-2`, `-3`, … counter handed out in
root order. Adding `@alpha/utils` at `packages/a-utils` therefore renamed its neighbours:
`utils-packages` became `utils-packages-2`, and `utils-packages-2` became `utils-packages-3`.
Component id is the key for `Symbol.component`, for both `Dependency` endpoints and for
cross-revision comparison, so one new package read downstream as every component having been
replaced.

The scope is folded into the id instead of discarded: `@alpha/utils` is `alpha-utils`. It is the
part of a published name that already distinguishes two same-named packages, and it is on the
package rather than on the workspace around it. An unscoped name is unchanged, and `@scope/` still
yields no id, so the next manifest is asked for one (`component-detect.md` §4.1 is a priority over
sources).

What is left after that is a genuine collision, and it is now resolved from the component's own
`roots[0]`. The suffix takes the parent directory as before, then one more step up the path for
every id still shared, until each is unique or its root has no ancestors left:
`team1/shared/pkg` and `team2/shared/pkg` are `pkg-shared-team1` and `pkg-shared-team2` rather
than `pkg-shared` and `pkg-shared-2`. A suffix that lands on another, already-unique id puts that
id in the next round too, so it moves as well. Whatever the path cannot separate — two roots whose
ancestor segments all kebab-case to nothing, or the workspace root, which has no ancestors — takes
a short hash of `roots[0]`, and every member of that group takes one: leaving the bare id with
whichever component sorted first is the positional input this change exists to remove.

Ids derived from a scoped name change. `@acme/billing-api` at `apps/billing` was `billing-api` and
is `acme-billing-api`; a workspace that pinned the old spelling anywhere — `components[].id` in
`aburi.json`, a slice or a stored IR compared against a new scan — should either declare the
component explicitly, which has always won over the derivation (`config.md` §6.1), or take the
rename once.
