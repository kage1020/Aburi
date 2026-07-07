---
"@aburi/github-action": minor
"@aburi/cli": patch
---

Add `@aburi/github-action` — a composite GitHub Action that runs `aburi diff` on a
pull request and upserts the resulting Markdown as a hidden-marker PR comment.

### Runtime shape

- **Composite action** (`action.yml`). Consumers reference it via
  `uses: kage1020/Aburi/packages/github-action@<tag>`. The `@aburi/cli` binary is
  resolved through `pnpm dlx @aburi/cli@<version>`, so the CLI version is pinned by the
  workflow author rather than the action tag — a policy that lets us ship CLI patches
  without cutting a new action release.
- **Steps**: input validation (`comment: true` requires markdown output) →
  refspec resolution (input `refspec` overrides; otherwise fall back to
  `pull_request.base.sha..pull_request.head.sha`) → `pnpm/action-setup` +
  `actions/setup-node` → `pnpm dlx @aburi/cli@<version> diff …` → PR-comment upsert
  via `actions/github-script@v7` → CLI exit-code propagation.
- **Exit-code propagation**: the diff step captures the CLI's status without failing
  the step so the comment upsert can still run when `--fail-on` fired (exit `3`); a
  trailing step then re-exits with the captured code, so a triggered gate fails the
  PR check *and* leaves the Markdown comment on the PR for the reviewer.
- **Comment step guard**: the upsert only runs when the CLI exits with `0` (clean) or
  `3` (gate triggered) — the two cases where the CLI actually produced `diff.md`. On
  `1` (runtime) / `2` (input) the comment step is skipped so a missing artefact
  cannot bury the CLI's real failure inside a secondary `ENOENT`.

### Artefact filenames

The action reads `diff.json` / `diff.md` from the CLI output directory. To keep those
literals in sync with the CLI without silent drift, `@aburi/cli` now exports
`DIFF_JSON_FILENAME` and `DIFF_MD_FILENAME` from a new `packages/cli/src/artifact-paths.ts`
module (used by `runDiff` and imported directly by the action's parity test). Renaming
either artefact on the CLI side now fails the github-action test at CI time instead of
producing a green build that ENOENTs at runtime — this is why the change is packaged
as a patch bump for `@aburi/cli` as well.

### Two comment-upsert implementations, one marker

The composite action's `github-script` step and the exported `upsertPullRequestComment`
helper are separate implementations that share the marker string
`<!-- aburi:diff-comment -->` — a test asserts that the marker literal is identical in
`src/comment.ts` and `action.yml`. The action step uses `github.paginate` from octokit;
the helper uses raw `fetch` with GHES support. Neither invokes the other:

- **`action.yml` github-script step (runtime)** — the code that actually runs inside
  the workflow. Uses `github.paginate` to walk the PR comment list, matches by marker,
  short-circuits on byte-equal body, otherwise PATCHes or POSTs. Not directly unit-testable;
  the manifest test proves the step is wired correctly (guarded by
  `inputs.comment == 'true'` + exit code, embeds the shared marker literal).
- **`src/comment.ts` (`upsertPullRequestComment`, programmatic API)** — an exported
  library helper for callers who want to post Aburi-style diff comments outside the
  composite action (bespoke workflows, downstream tools). Uses raw `fetch` with an
  injectable `apiBase` for GitHub Enterprise Server. `buildApiUrl` normalises the base
  so a `/api/v3` mount path is preserved (a naïve `new URL(absolute, base)` would drop it).
  Full fake-fetch coverage in `test/comment.test.ts`.

### Silent failure eradication

- **Byte-equal short-circuit**: when the existing comment body already matches, the
  action returns `unchanged` and skips the PATCH request — no notification bump on
  no-op re-runs.
- **API errors are loud**: every non-2xx response from the GitHub REST API throws with
  the operation label, status code, and a 400-char response snippet — a token scope
  typo is loud rather than silent-drop-then-green.
- **Non-array list response** (contract violation from the API) throws instead of being
  treated as "no comments".
- **Missing `id`/`body`/`html_url`** in a create/patch response throws instead of
  writing back an invalid outcome record.

### Public API

`upsertPullRequestComment`, `ensureMarker`, `ABURI_COMMENT_MARKER`, and the option /
outcome types are re-exported from `@aburi/github-action` for callers who want to post
Aburi-style diff comments programmatically without invoking the composite action.

### Inputs / outputs

Inputs: `version` (default `latest`), `refspec`, `fail-on`, `config`, `output-dir`
(default `out`), `format` (default `both`), `working-directory`, `comment`
(default `true`), `token` (default `${{ github.token }}`), `node-version`
(default `24`), `pnpm-version` (default `10`). Outputs: `diff-json-path`,
`diff-md-path`, `cli-exit-code` (`0` clean / `1` runtime / `2` input / `3` gate or
plugin — matches `packages/cli/src/exit-codes.ts`), `comment-id`, `comment-action`
(`created` / `updated` / `unchanged`).

### Tests

- `test/comment.test.ts` (14): `upsertPullRequestComment` create / update / unchanged
  / pagination / GET-error / POST-error / PATCH-error / null-body responses on POST +
  PATCH / bearer token / GHES apiBase / non-array response rejection.
- `test/action-yml.test.ts` (12): required inputs and defaults, `pnpm dlx` command
  shape, comment step guarded by `inputs.comment == 'true'` + `cli-exit-code`, marker
  parity between YAML and `comment.ts`, exit-code propagation step, output
  declarations, refspec fallback rejecting non-PR events, `comment=true + format=json`
  validation, filename parity with `DIFF_JSON_FILENAME` / `DIFF_MD_FILENAME` from
  `@aburi/cli` (so a CLI-side rename fails here), exit-code table wording.
