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
package rather than on the workspace around it. An unscoped name is unchanged, and `@scope/`
still yields no id, so the next manifest is asked for one (`component-detect.md` §4.1 is a
priority over sources). The fold is over the bare name's id rather than the raw string, so
`@acme/---` still aborts with `invalid-component-id` naming the package instead of quietly
becoming `acme`.

What is left after that is a genuine collision, and it is now resolved from the component's own
`roots[0]`. The suffix takes the parent directory as before, then one more step up the path for
every id still shared, until each is unique or its root has no ancestors left:
`team1/shared/pkg` and `team2/shared/pkg` are `pkg-shared-team1` and `pkg-shared-team2` rather
than `pkg-shared` and `pkg-shared-2`. What the path cannot separate takes a short digest of
`roots[0]` appended to the id it reached (`utils-packages-b9b98f98`), and every member of that
group takes one: leaving the bare id with whichever component sorted first is the positional
input this change exists to remove. Because that separates by digest rather than by
construction, uniqueness is checked once on exit and a surviving duplicate aborts with the new
`component-id-collision-unresolved` — `aburi init` writes `components[]` without building an IR,
so the ir-schema.md §14 #2 invariant is not the one that would catch it.

The promise is that an id never depends on a component's position among the others, not that an
id never moves. A package arriving with an id already in use still moves whoever holds it — add
`packages/x` named `shared-libs` and `team/libs/shared` becomes `shared-libs-team`. What has
changed is the reach: before, any package under the same parent renumbered its neighbours; now
only a package contending for the same id moves anything.

**Migration.** Ids derived from a scoped name change: `@acme/billing-api` at `apps/billing` was
`billing-api` and is `acme-billing-api`. Folding also erases the namespace boundary, so
`@foo/bar-baz`, `@foo-bar/baz` and an unscoped `foo-bar-baz` now derive one id where the first
two were distinct — which means a scoped package can newly collide with an *unscoped* neighbour
that was never involved before, and both come out of that collision with suffixed or hashed ids.
A workspace that pinned any old spelling — `components[].id` in `aburi.json`, a slice, or a
stored IR compared against a new scan — should either declare the component explicitly, which
has always won over the derivation (`config.md` §6.1), or take the rename once.
